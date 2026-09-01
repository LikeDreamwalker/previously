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
 * LOOP BRAKE: the original Previously Agent failure mode was resubmitting the
 * SAME rejected write verbatim until the step cap killed the pass. The session
 * tracks rejections per (tool + whitespace-normalized args):
 *   2nd identical rejection → the rejection text is prefixed with an escalation
 *     that states the exact arithmetic (length violations) so the model cannot
 *     "compress" by two chars and resubmit;
 *   3rd identical rejection → a length-class violation is FORCE-APPLIED,
 *     truncated to the cap (log marked `forced:`); any other class (missing
 *     refs, duplicates, no-match, …) cannot be fixed mechanically, so the write
 *     is SKIPPED with an instruction to finish immediately with the card as-is.
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
  /** Loop brake: rejections per (tool + normalized args) — see the file header. */
  rejections: Map<string, number>;
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
  return { doc, log: [], today, rejections: new Map() };
}

/** Serialize the session's working document — the final card text. */
export function serializeSession(session: CardSession): string {
  return serializeCard(session.doc);
}

/**
 * Substance comparison — ignores the sliceId/updated stamps, which refresh on
 * every pass. True when identity/past/now/horizon are identical. The legacy
 * selfModel list is compared too, so stripping a legacy `## Self-model`
 * section (the writer never re-emits it) correctly registers as a change.
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

// ─── Loop brake ───────────────────────────────────────────────────────────
// (See the file header for the rationale.) Rejections are tracked per
// (tool + whitespace-normalized args) so the model cannot escape the brake by
// tweaking a space or the casing.

/** Whitespace/case-tolerant key for one tool invocation. */
function brakeKey(tool: string, ...args: unknown[]): string {
  const norm = (v: unknown): string =>
    typeof v === "string"
      ? v.trim().replace(/\s+/g, " ").toLowerCase()
      : (JSON.stringify(v) ?? "");
  return `${tool}:${args.map(norm).join("|")}`;
}

interface Brake {
  /** The rejection text to return (escalated on repeats) — unless `force`. */
  message: string;
  /** 3rd identical LENGTH-class rejection: the caller truncates and applies. */
  force: boolean;
}

function trackRejection(
  session: CardSession,
  key: string,
  base: string,
  length?: { actual: number; limit: number },
): Brake {
  const count = (session.rejections.get(key) ?? 0) + 1;
  session.rejections.set(key, count);
  if (count < 2) return { message: base, force: false };
  if (count >= 3 && length) return { message: "", force: true };
  const prefix =
    count >= 3
      ? `LOOP BRAKE (attempt ${count}): this exact write keeps failing and cannot be fixed mechanically — it is now SKIPPED. Do NOT retry it; call finish NOW with the card as it stands.\n`
      : length
        ? `LOOP BRAKE (attempt ${count}): you resubmitted nearly identical content and it was rejected again. The arithmetic is not negotiable — ${length.actual} chars against a ${length.limit} limit means you must DELETE at least ${length.actual - length.limit} chars before resubmitting. Rewrite, don't resubmit.\n`
        : `LOOP BRAKE (attempt ${count}): you resubmitted nearly identical content and it was rejected again. Change the CONTENT of your next attempt — a whitespace tweak does not count.\n`;
  return { message: prefix + base, force: false };
}

/**
 * Length validation wired into the loop brake. Returns:
 *   null            → length OK, proceed;
 *   { reject }      → still rejected — return this text (escalated on repeats);
 *   { forcedText }  → 3rd identical over-limit attempt: apply this truncation.
 * Only the over-limit case is mechanically fixable; empty / multi-line writes
 * take the non-length escalation path.
 */
function brakeLength(
  session: CardSession,
  key: string,
  field: string,
  text: string,
  max: number,
  emptyOverride?: string,
): { reject: string } | { forcedText: string } | null {
  const err = checkLength(field, text, max);
  if (!err) return null;
  const base =
    emptyOverride && err === `REJECTED: ${field} is empty.` ? emptyOverride : err;
  const overLimit = text.trim().length > 0 && !text.includes("\n") && text.length > max;
  const brake = trackRejection(
    session,
    key,
    base,
    overLimit ? { actual: text.length, limit: max } : undefined,
  );
  return brake.force ? { forcedText: text.trim().slice(0, max) } : { reject: brake.message };
}

/** Non-length rejection path of the brake — returns the (possibly escalated) text. */
function brakeReject(session: CardSession, key: string, base: string): string {
  return trackRejection(session, key, base).message;
}

/** Result text for a force-applied write. */
function forcedOk(what: string, limit: number): string {
  return `OK — FORCED: ${what} was truncated to the ${limit}-char limit and applied after repeated identical rejections. Call finish when your remaining writes are done.`;
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
  const key = brakeKey("setIdentity", field, value);
  const len = brakeLength(session, key, `Identity ${field}`, value, SELF_MODEL_LINE_MAX_CHARS);
  let effective = value.trim();
  let forced = false;
  if (len) {
    if ("forcedText" in len) {
      effective = len.forcedText;
      forced = true;
    } else return len.reject;
  }
  const label = IDENTITY_LABELS[field];
  const line = `${label}: ${effective}`;
  const idx = session.doc.identity.findIndex((l) =>
    l.toLowerCase().startsWith(label.toLowerCase() + ":"),
  );
  if (idx >= 0) {
    session.doc.identity[idx] = line;
    session.log.push(`${forced ? "forced: " : ""}setIdentity: ${label} updated`);
    return forced ? forcedOk(label, SELF_MODEL_LINE_MAX_CHARS) : `OK — ${label} updated in place.`;
  }
  if (session.doc.identity.length >= IDENTITY_MAX_LINES)
    return brakeReject(session, key, `REJECTED: Identity head is full (${IDENTITY_MAX_LINES} lines). Replace an existing field instead of adding.`);
  session.doc.identity.push(line);
  session.log.push(`${forced ? "forced: " : ""}setIdentity: ${label} added`);
  return forced
    ? forcedOk(label, SELF_MODEL_LINE_MAX_CHARS)
    : `OK — ${label} added (${session.doc.identity.length}/${IDENTITY_MAX_LINES} Identity lines).`;
}

// ─── Past ─────────────────────────────────────────────────────────────────

export function sessionUpdatePastProfile(session: CardSession, text: string): string {
  const key = brakeKey("updatePastProfile", text);
  const len = brakeLength(
    session,
    key,
    "Past profile",
    text,
    CARD_PROFILE_MAX_CHARS,
    "REJECTED: the Past profile cannot be emptied — rewrite it in place with the new paragraph.",
  );
  if (len && !("forcedText" in len)) return len.reject;
  if (len && "forcedText" in len) {
    session.doc.past.profile = len.forcedText;
    session.log.push(`forced: updatePastProfile truncated to ${CARD_PROFILE_MAX_CHARS} chars`);
    return forcedOk("Past profile", CARD_PROFILE_MAX_CHARS);
  }
  session.doc.past.profile = text.trim();
  session.log.push("updatePastProfile: profile rewritten");
  return `OK — Past profile updated (${text.trim().length}/${CARD_PROFILE_MAX_CHARS} chars).`;
}

export function sessionAddPastAnchor(
  session: CardSession,
  text: string,
  refs: string[],
): string {
  const key = brakeKey("addPastAnchor", text, refs);
  let effective = text.trim();
  let forced = false;
  const len = brakeLength(session, key, "Past anchor", text, PAST_ANCHOR_MAX_CHARS);
  if (len) {
    if ("forcedText" in len) {
      effective = len.forcedText;
      forced = true;
    } else return len.reject;
  }
  const err =
    checkRefs(refs) ??
    checkDup(session.doc.past.anchors.map((a) => a.text), effective, "Past anchor");
  if (err) return brakeReject(session, key, err);
  if (session.doc.past.anchors.length >= PAST_ANCHORS_MAX)
    return brakeReject(session, key, `REJECTED: Past anchors are full (${PAST_ANCHORS_MAX}). Remove a stale anchor first, or fold the fact into the profile paragraph instead. Admission test: "almost certainly still true in 3 years?"`);
  session.doc.past.anchors.push({ text: effective, refs });
  session.log.push(`${forced ? "forced: " : ""}addPastAnchor: ${effective.slice(0, 50)}`);
  return forced
    ? forcedOk("Past anchor", PAST_ANCHOR_MAX_CHARS)
    : `OK — anchor added (${session.doc.past.anchors.length}/${PAST_ANCHORS_MAX}).`;
}

export function sessionRemovePastAnchor(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.past.anchors, match);
  if (!hit)
    return brakeReject(session, brakeKey("removePastAnchor", match), noMatch("Past anchor", match, session.doc.past.anchors));
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
  const key = brakeKey("addNow", text, refs, since ?? "");
  let effective = text.trim();
  let forced = false;
  const len = brakeLength(session, key, "Now item", text, NOW_ITEM_MAX_CHARS);
  if (len) {
    if ("forcedText" in len) {
      effective = len.forcedText;
      forced = true;
    } else return len.reject;
  }
  const err =
    checkRefs(refs) ??
    checkDup(session.doc.now.map((r) => r.text), effective, "Now");
  if (err) return brakeReject(session, key, err);
  const date = since ?? session.today;
  if (!DATE_RE.test(date))
    return brakeReject(session, key, `REJECTED: since must be YYYY-MM-DD (got "${date}") — use the user's local date given in the prompt.`);
  if (session.doc.now.length >= CARD_NOW_MAX)
    return brakeReject(session, key, `REJECTED: Now is full (${CARD_NOW_MAX}). Remove a stale item or promote one to Past first — one event per line, newest first.`);
  session.doc.now.unshift({ text: effective, refs, since: date });
  session.log.push(`${forced ? "forced: " : ""}addNow: ${effective.slice(0, 50)}`);
  return forced
    ? forcedOk("Now item", NOW_ITEM_MAX_CHARS)
    : `OK — Now item added (${session.doc.now.length}/${CARD_NOW_MAX}), since: ${date}.`;
}

export function sessionRemoveNow(session: CardSession, match: string): string {
  const hit = findMatch(session.doc.now, match);
  if (!hit)
    return brakeReject(session, brakeKey("removeNow", match), noMatch("Now", match, session.doc.now));
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
  const key = brakeKey("promoteNowToPast", match);
  const hit = findMatch(session.doc.now, match);
  if (!hit) return brakeReject(session, key, noMatch("Now", match, session.doc.now));
  if (session.doc.past.anchors.length >= PAST_ANCHORS_MAX)
    return brakeReject(session, key, `REJECTED: Past anchors are full (${PAST_ANCHORS_MAX}) — remove a stale anchor first, or fold the substance into the profile paragraph with updatePastProfile + removeNow.`);
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
  const key = brakeKey("addHorizon", text, by, refs);
  let effective = text.trim();
  let forced = false;
  const len = brakeLength(session, key, "Horizon item", text, HORIZON_ITEM_MAX_CHARS);
  if (len) {
    if ("forcedText" in len) {
      effective = len.forcedText;
      forced = true;
    } else return len.reject;
  }
  const err =
    checkRefs(refs) ??
    checkDup(session.doc.horizon.map((h) => h.text), effective, "Horizon");
  if (err) return brakeReject(session, key, err);
  if (!DATE_RE.test(by))
    return brakeReject(session, key, `REJECTED: by must be YYYY-MM-DD (got "${by}") — every open loop carries an explicit due date.`);
  if (session.doc.horizon.length >= HORIZON_MAX)
    return brakeReject(session, key, `REJECTED: Horizon is full (${HORIZON_MAX}). Resolve or merge an existing loop first — one commitment per line.`);
  session.doc.horizon.push({ text: effective, by, refs });
  session.log.push(`${forced ? "forced: " : ""}addHorizon: ${effective.slice(0, 50)}`);
  return forced
    ? forcedOk("Horizon item", HORIZON_ITEM_MAX_CHARS)
    : `OK — Horizon item added (${session.doc.horizon.length}/${HORIZON_MAX}), by: ${by}.`;
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
  if (!hit)
    return brakeReject(session, brakeKey("resolveHorizon", match, note ?? ""), noMatch("Horizon", match, session.doc.horizon));
  session.doc.horizon = session.doc.horizon.filter((h) => h !== hit);
  session.log.push(`resolveHorizon: ${hit.text.slice(0, 50)}${note ? ` (${note})` : ""}`);
  return `OK — Horizon item resolved: "${hit.text.slice(0, 60)}".${
    note ? "" : " If the outcome matters, record it via addNow / updatePastProfile."
  }`;
}

// NOTE: there are deliberately NO Self-model session mutations — the card is a
// pure semantic memory pool (Identity/Past/Now/Horizon); user patterns live in
// the evolution direction's Portrait (src/lib/evolution/direction-agent.ts).
// parseCard still fills doc.selfModel from a LEGACY card so the old lines
// survive until the evolution agent migrates them; serializeSession never
// writes the section back.
