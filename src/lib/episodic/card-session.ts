/**
 * Card session — the mutation layer behind the Previously Agent's write tools.
 *
 * The agent never writes the whole card. It holds an in-memory CardDocument
 * (parsed from the current card) and applies FINE-GRAINED mutations through
 * these functions, each wired to a tool. Validation lives HERE, not in a
 * post-hoc pass: an over-limit / malformed write is REJECTED with feedback
 * ("2630 chars, limit 2400 — compress and retry"), so the agent itself decides
 * what survives the cap. Untouched parts of the card are preserved by
 * construction — a mutation session cannot silently drop a line it never
 * looked at.
 *
 * Tool-result convention:
 *   success   → "OK — <what was applied> (<resulting state>)"
 *   rejection → "REJECTED: <why> — <how to fix it>"
 * The rejection text is the model's retry instruction; keep it specific.
 *
 * Pure in-memory — no I/O, no LLM calls. The owning workflow step creates the
 * session, hands these functions to the agent's tools, and serializes at the
 * end.
 */
import {
  parseCard,
  serializeCard,
  CARD_PROFILE_MAX_CHARS,
  NOW_ITEM_MAX_CHARS,
  HORIZON_ITEM_MAX_CHARS,
  SELF_MODEL_LINE_MAX_CHARS,
  PAST_ANCHOR_MAX_CHARS,
  CARD_NOW_MAX,
  CARD_SELF_MODEL_MAX,
  PAST_ANCHORS_MAX,
  HORIZON_MAX,
  type CardDocument,
} from "./previously-format";

// ─── Session ─────────────────────────────────────────────────────────────

export interface CardSession {
  /** The working document — mutated in place by the session functions. */
  doc: CardDocument;
  /** Compact log of every APPLIED mutation ("addNow: prepping friday interview"). */
  log: string[];
  /** The user's LOCAL calendar date (YYYY-MM-DD) — the default `since` for new Now items. */
  today: string;
}

/**
 * Start a mutation session from the current card content. A legacy (v1) card
 * parses onto the v5 sections; an unparseable document (v3 free-form) starts
 * EMPTY — the raw legacy text stays visible in the agent's prompt and it
 * rebuilds the content through mutations.
 */
export function createCardSession(
  baseContent: string,
  sliceId: string,
  today: string,
  nowIso = new Date().toISOString(),
): CardSession {
  const parsed = baseContent.trim() ? parseCard(baseContent) : null;
  const doc: CardDocument =
    parsed ?? {
      sliceId,
      updated: nowIso,
      identity: [],
      past: { profile: "", anchors: [] },
      now: [],
      horizon: [],
      selfModel: [],
    };
  doc.sliceId = sliceId;
  doc.updated = nowIso;
  return { doc, log: [], today };
}

/** Serialize the session's working document — the final card text. */
export function serializeSession(session: CardSession): string {
  return serializeCard(session.doc);
}

/**
 * Substance comparison — ignores the sliceId/updated stamps, which refresh on
 * every pass. True when identity/past/now/horizon/self-model are identical.
 */
export function sameCardSubstance(
  a: CardDocument | null,
  b: CardDocument | null,
): boolean {
  const substance = (d: CardDocument | null) =>
    JSON.stringify({
      identity: d?.identity ?? [],
      past: d?.past ?? { profile: "", anchors: [] },
      now: d?.now ?? [],
      horizon: d?.horizon ?? [],
      selfModel: d?.selfModel ?? [],
    });
  return substance(a) === substance(b);
}

// ─── Validation helpers ───────────────────────────────────────────────────

const REF_RE = /^\d{4}\/\d{2}\/\d{2}\/\d{4}(-[A-Za-z0-9]+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Slice ids everywhere else are dash-form (YYYY-MM-DD-HHMM) — the worker
 *  naturally cites them as-is. Accept that form too. */
const REF_DASH_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{4}(-[A-Za-z0-9]+)?)$/;

/** Normalize one ref to the canonical slash form; null when unrecognizable. */
function normalizeRef(ref: string): string | null {
  if (REF_RE.test(ref)) return ref;
  const m = REF_DASH_RE.exec(ref.trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}

function checkLength(field: string, text: string, max: number): string | null {
  if (!text.trim()) return `REJECTED: ${field} is empty.`;
  if (text.includes("\n"))
    return `REJECTED: ${field} must be a single line (${text.length} chars incl. a line break).`;
  if (text.length > max)
    return `REJECTED: ${field} is ${text.length} chars — the limit is ${max}. Compress it and retry; YOU decide what to keep, nothing is truncated for you.`;
  return null;
}

function checkRefs(refs: string[]): string | null {
  if (refs.length === 0)
    return "REJECTED: refs are required — cite the evidence slice (e.g. [\"2026/08/07/0709\"]). No evidence, no write.";
  // Validate + normalize IN PLACE: dash-form slice ids become slash-form, so a
  // ref copied verbatim from the slice id no longer bounces.
  for (let i = 0; i < refs.length; i++) {
    const normalized = normalizeRef(refs[i]);
    if (!normalized)
      return `REJECTED: malformed ref "${refs[i]}" — expected the evidence slice id (YYYY-MM-DD-HHMM, optionally -turnId).`;
    refs[i] = normalized;
  }
  return null;
}

function checkDup(existing: string[], text: string, section: string): string | null {
  const norm = (s: string) => s.trim().toLowerCase();
  if (existing.some((t) => norm(t) === norm(text)))
    return `REJECTED: this ${section} entry is already on the card — merge or edit in place instead of duplicating.`;
  return null;
}

/**
 * Find items whose text contains `match` (case-insensitive). On no match the
 * caller returns a rejection listing the current entries so the agent can fix
 * its match string instead of guessing.
 */
function findMatch<T extends { text: string }>(
  items: T[],
  match: string,
): T | undefined {
  const m = match.trim().toLowerCase();
  if (!m) return undefined;
  return items.find((it) => it.text.toLowerCase().includes(m));
}

function previewList(items: Array<{ text: string }>): string {
  if (items.length === 0) return "(none)";
  return items.map((i) => `"${i.text.slice(0, 60)}"`).join(", ");
}

function noMatch(section: string, match: string, items: Array<{ text: string }>): string {
  return `REJECTED: no ${section} entry contains "${match}". Current entries: ${previewList(items)}. Retry with a substring of the entry you mean.`;
}

// ─── Self-model invariant backstop ─────────────────────────────────────────
// (Moved from the retired previously-updater. The prompt's delta rule is the
// primary guard; this backstop ensures a single bad line can never break core
// tool discipline — unless the user explicitly overrode it.)

const SELF_MODEL_INVARIANTS: Array<{ re: RegExp; rule: string }> = [
  { re: /never\s+use\s+(the\s+)?recall/i, rule: "recall is the memory-search tool" },
  { re: /don'?t\s+(use|call)\s+(the\s+)?recall/i, rule: "recall is the memory-search tool" },
  { re: /never\s+read\s+(the\s+)?(memory|slices)/i, rule: "readSlice/recall are the memory tools" },
];

function contradictsInvariant(line: string): string | null {
  if (/\boverrides\s*[:=]/.test(line)) return null; // explicit user override
  const hit = SELF_MODEL_INVARIANTS.find(({ re }) => re.test(line));
  return hit ? hit.rule : null;
}

// ─── Identity ─────────────────────────────────────────────────────────────

const IDENTITY_LABELS = {
  name: "Name",
  address_as: "Address them as",
  pronouns: "Pronouns",
  alias: "Alias",
} as const;

export type IdentityField = keyof typeof IDENTITY_LABELS;
const IDENTITY_MAX_LINES = 8;

export function sessionSetIdentity(
  session: CardSession,
  field: IdentityField,
  value: string,
): string {
  const err = checkLength(`Identity ${field}`, value, SELF_MODEL_LINE_MAX_CHARS);
  if (err) return err;
  const label = IDENTITY_LABELS[field];
  const line = `${label}: ${value.trim()}`;
  const idx = session.doc.identity.findIndex((l) =>
    l.toLowerCase().startsWith(label.toLowerCase() + ":"),
  );
  if (idx >= 0) {
    session.doc.identity[idx] = line;
    session.log.push(`setIdentity: ${label} updated`);
    return `OK — ${label} updated in place.`;
  }
  if (session.doc.identity.length >= IDENTITY_MAX_LINES)
    return `REJECTED: Identity head is full (${IDENTITY_MAX_LINES} lines). Replace an existing field instead of adding.`;
  session.doc.identity.push(line);
  session.log.push(`setIdentity: ${label} added`);
  return `OK — ${label} added (${session.doc.identity.length}/${IDENTITY_MAX_LINES} Identity lines).`;
}

// ─── Past ─────────────────────────────────────────────────────────────────

export function sessionUpdatePastProfile(session: CardSession, text: string): string {
  const err = checkLength("Past profile", text, CARD_PROFILE_MAX_CHARS);
  if (err)
    return err === `REJECTED: Past profile is empty.`
      ? "REJECTED: the Past profile cannot be emptied — rewrite it in place with the new paragraph."
      : err;
  session.doc.past.profile = text.trim();
  session.log.push("updatePastProfile: profile rewritten");
  return `OK — Past profile updated (${text.trim().length}/${CARD_PROFILE_MAX_CHARS} chars).`;
}

export function sessionAddPastAnchor(
  session: CardSession,
  text: string,
  refs: string[],
): string {
  const err =
    checkLength("Past anchor", text, PAST_ANCHOR_MAX_CHARS) ??
    checkRefs(refs) ??
    checkDup(session.doc.past.anchors.map((a) => a.text), text, "Past anchor");
  if (err) return err;
  if (session.doc.past.anchors.length >= PAST_ANCHORS_MAX)
    return `REJECTED: Past anchors are full (${PAST_ANCHORS_MAX}). Remove a stale anchor first, or fold the fact into the profile paragraph instead. Admission test: "almost certainly still true in 3 years?"`;
  session.doc.past.anchors.push({ text: text.trim(), refs });
  session.log.push(`addPastAnchor: ${text.trim().slice(0, 50)}`);
  return `OK — anchor added (${session.doc.past.anchors.length}/${PAST_ANCHORS_MAX}).`;
}

export function sessionRemovePastAnchor(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.past.anchors, match);
  if (!hit) return noMatch("Past anchor", match, session.doc.past.anchors);
  session.doc.past.anchors = session.doc.past.anchors.filter((a) => a !== hit);
  session.log.push(`removePastAnchor: ${hit.text.slice(0, 50)}`);
  return `OK — anchor removed: "${hit.text.slice(0, 60)}".`;
}

// ─── Now ──────────────────────────────────────────────────────────────────

export function sessionAddNow(
  session: CardSession,
  text: string,
  refs: string[],
  since?: string,
): string {
  const err =
    checkLength("Now item", text, NOW_ITEM_MAX_CHARS) ??
    checkRefs(refs) ??
    checkDup(session.doc.now.map((r) => r.text), text, "Now");
  if (err) return err;
  const date = since ?? session.today;
  if (!DATE_RE.test(date))
    return `REJECTED: since must be YYYY-MM-DD (got "${date}") — use the user's local date given in the prompt.`;
  if (session.doc.now.length >= CARD_NOW_MAX)
    return `REJECTED: Now is full (${CARD_NOW_MAX}). Remove a stale item or promote one to Past first — one event per line, newest first.`;
  session.doc.now.unshift({ text: text.trim(), refs, since: date });
  session.log.push(`addNow: ${text.trim().slice(0, 50)}`);
  return `OK — Now item added (${session.doc.now.length}/${CARD_NOW_MAX}), since: ${date}.`;
}

export function sessionRemoveNow(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.now, match);
  if (!hit) return noMatch("Now", match, session.doc.now);
  session.doc.now = session.doc.now.filter((r) => r !== hit);
  session.log.push(`removeNow: ${hit.text.slice(0, 50)}`);
  return `OK — Now item removed: "${hit.text.slice(0, 60)}".`;
}

/**
 * Promote a Now item to a durable Past anchor (keeps its refs). For folding
 * the substance into the profile PARAGRAPH instead, use updatePastProfile +
 * removeNow.
 */
export function sessionPromoteNowToPast(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.now, match);
  if (!hit) return noMatch("Now", match, session.doc.now);
  if (session.doc.past.anchors.length >= PAST_ANCHORS_MAX)
    return `REJECTED: Past anchors are full (${PAST_ANCHORS_MAX}) — remove a stale anchor first, or fold the substance into the profile paragraph with updatePastProfile + removeNow.`;
  // No length check: this MOVES text already on the card — rejecting it for a
  // limit the agent didn't author (legacy over-length items) traps the pass in
  // a rejection loop it cannot escape. Folding via updatePastProfile remains
  // the path for compressing the substance.
  session.doc.now = session.doc.now.filter((r) => r !== hit);
  session.doc.past.anchors.push({ text: hit.text, refs: hit.refs });
  session.log.push(`promoteNowToPast: ${hit.text.slice(0, 50)}`);
  return `OK — promoted to Past anchors: "${hit.text.slice(0, 60)}".`;
}

// ─── Horizon ──────────────────────────────────────────────────────────────

export function sessionAddHorizon(
  session: CardSession,
  text: string,
  by: string,
  refs: string[],
): string {
  const err =
    checkLength("Horizon item", text, HORIZON_ITEM_MAX_CHARS) ??
    checkRefs(refs) ??
    checkDup(session.doc.horizon.map((h) => h.text), text, "Horizon");
  if (err) return err;
  if (!DATE_RE.test(by))
    return `REJECTED: by must be YYYY-MM-DD (got "${by}") — every open loop carries an explicit due date.`;
  if (session.doc.horizon.length >= HORIZON_MAX)
    return `REJECTED: Horizon is full (${HORIZON_MAX}). Resolve or merge an existing loop first — one commitment per line.`;
  session.doc.horizon.push({ text: text.trim(), by, refs });
  session.log.push(`addHorizon: ${text.trim().slice(0, 50)}`);
  return `OK — Horizon item added (${session.doc.horizon.length}/${HORIZON_MAX}), by: ${by}.`;
}

/**
 * Resolve (remove) a Horizon open loop. Horizon items are NEVER age-expired —
 * this is the only way they leave the card. Record where the outcome went in
 * `note` (e.g. "folded into Now" / "dropped — user cancelled").
 */
export function sessionResolveHorizon(
  session: CardSession,
  match: string,
  note?: string,
): string {
  const hit = findMatch(session.doc.horizon, match);
  if (!hit) return noMatch("Horizon", match, session.doc.horizon);
  session.doc.horizon = session.doc.horizon.filter((h) => h !== hit);
  session.log.push(`resolveHorizon: ${hit.text.slice(0, 50)}${note ? ` (${note})` : ""}`);
  return `OK — Horizon item resolved: "${hit.text.slice(0, 60)}".${
    note ? "" : " If the outcome matters, record it via addNow / updatePastProfile."
  }`;
}

// ─── Self-model ───────────────────────────────────────────────────────────

export function sessionAddSelfModel(session: CardSession, text: string): string {
  const err =
    checkLength("Self-model line", text, SELF_MODEL_LINE_MAX_CHARS) ??
    checkDup(session.doc.selfModel, text, "Self-model");
  if (err) return err;
  const rule = contradictsInvariant(text);
  if (rule)
    return `REJECTED: this contradicts the standing rule "${rule}". If the user EXPLICITLY overrode it, append "overrides: <rule>" citing their words; otherwise drop this lesson.`;
  if (session.doc.selfModel.length >= CARD_SELF_MODEL_MAX)
    return `REJECTED: Self-model is full (${CARD_SELF_MODEL_MAX}). Remove an obsolete lesson first — the list is a delta, not an archive.`;
  session.doc.selfModel.push(text.trim());
  session.log.push(`addSelfModel: ${text.trim().slice(0, 50)}`);
  return `OK — Self-model line added (${session.doc.selfModel.length}/${CARD_SELF_MODEL_MAX}).`;
}

export function sessionRemoveSelfModel(session: CardSession, match: string): string {
  const items = session.doc.selfModel.map((text) => ({ text }));
  const hit = findMatch(items, match);
  if (!hit) return noMatch("Self-model", match, items);
  session.doc.selfModel = session.doc.selfModel.filter((l) => l !== hit.text);
  session.log.push(`removeSelfModel: ${hit.text.slice(0, 50)}`);
  return `OK — Self-model line removed: "${hit.text.slice(0, 60)}".`;
}
