/**
 * Previously Updater — pure functions that apply Previously Agent mutations
 * to a previously.md body string (v3 two-section archive).
 *
 * All functions are pure: string in, string out. No I/O, no LLM calls.
 *
 * Actions (across the profile / self_model sections, keyed by dimension):
 *   - observe     : add a new entry
 *   - reinforce   : bump obs count and update last-seen date
 *   - contradict  : drop confidence, mark refuted (user correction)
 *   - discard     : remove the entry
 *   - expire      : remove an expired short-lived entry (current_state / boundaries)
 *   - promote     : move a current_state entry to a stable dimension
 *   - demote      : move a stable entry to current_state
 *
 * A `reformat` content, when provided, replaces the document wholesale (used
 * for format/version drift). Bounds (profile ≤ 40, self_model ≤ 30) are
 * enforced deterministically by evicting the weakest entries by
 * confidence × recency.
 */

import type { PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";
import {
  parsePreviously,
  migrateToV3,
  serializePreviously,
  formatDate,
  formatExpiry,
  type PreviouslyBelief,
  type PreviouslyDocument,
  type ProfileDimension,
  type SelfModelDimension,
  type Section,
  PROFILE_DIMENSIONS,
  SELF_MODEL_DIMENSIONS,
} from "@/lib/episodic/previously-format";

// ─── Main entry point ───────────────────────────────────────────────────

export interface ApplyResult {
  content: string;
  changes: {
    added: number;
    reinforced: number;
    demoted: number;
    removed: number;
    superseded: number;
  };
  /** True only when a provided `reformatContent` was actually applied (parsed as valid v3). */
  reformatted: boolean;
}

/**
 * Apply a batch of PreviouslyAgent mutations to a previously.md body,
 * or replace it wholesale when `reformatContent` is provided.
 * Returns the updated content + a summary of changes.
 */
export function applyPreviouslyAgentOutput(
  content: string,
  mutations: PreviouslyMutation[],
  currentSliceId: string,
  reformatContent?: string,
): ApplyResult {
  const emptyChanges: ApplyResult["changes"] = {
    added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0,
  };

  // ── Reformat path: wholesale replacement. ─────────────────────────────
  if (reformatContent && reformatContent.trim()) {
    const parsed = parsePreviously(reformatContent);
    if (parsed) {
      parsed.sliceId = currentSliceId || parsed.sliceId;
      parsed.updated = new Date().toISOString();
      enforceLimits(parsed);
      return {
        content: serializePreviously(parsed),
        changes: emptyChanges,
        reformatted: true,
      };
    }
    // Invalid reformat — fall through to incremental mutations rather than
    // clobbering the archive with unparseable content.
  }

  // ── Parse current content. Legacy v1/v2 content is migrated on the fly. ──
  let doc = parsePreviously(content);
  if (!doc) {
    doc = parsePreviously(migrateToV3(content, currentSliceId));
  }
  if (!doc) {
    return { content, changes: emptyChanges, reformatted: false };
  }

  const changes: ApplyResult["changes"] = { ...emptyChanges };

  if (mutations.length === 0) {
    // No-op pass: enforce limits without stamping a new `updated` timestamp,
    // so an unchanged document round-trips byte-identically.
    enforceLimits(doc);
    return { content: serializePreviously(doc), changes, reformatted: false };
  }

  doc.updated = new Date().toISOString();
  if (currentSliceId) doc.sliceId = currentSliceId;

  // Sanitize: fill missing evidence refs with the current slice (the exchange
  // under review is the default evidence source for new entries).
  const currentSlicePath = currentSliceId.replace(/-/g, "/");
  const sanitized = mutations.map((m) =>
    !m.evidence_slice || m.evidence_slice === "undefined"
      ? { ...m, evidence_slice: currentSlicePath }
      : m,
  );

  // Separate by type for ordered processing (remove → modify → add).
  const expires = sanitized.filter((m) => m.action === "expire");
  const discards = sanitized.filter((m) => m.action === "discard");
  const contradicts = sanitized.filter((m) => m.action === "contradict");
  const reinforces = sanitized.filter((m) => m.action === "reinforce");
  const observes = sanitized.filter((m) => m.action === "observe");
  const promotes = sanitized.filter((m) => m.action === "promote");
  const demotes = sanitized.filter((m) => m.action === "demote");

  for (const m of [...expires, ...discards]) {
    changes.removed += applyRemove(doc, m);
  }

  for (const m of contradicts) {
    if (applyContradict(doc, m)) changes.demoted += 1;
  }

  for (const m of reinforces) {
    if (applyReinforce(doc, m)) changes.reinforced += 1;
  }

  for (const m of demotes) {
    if (applyDemote(doc, m)) changes.demoted += 1;
  }

  for (const m of promotes) {
    if (applyPromote(doc, m)) changes.added += 1;
  }

  for (const m of observes) {
    if (applyObserve(doc, m)) changes.added += 1;
  }

  // Enforce quantity limits (profile ≤ 40, self_model ≤ 30).
  enforceLimits(doc);

  return { content: serializePreviously(doc), changes, reformatted: false };
}

// ─── Action helpers ─────────────────────────────────────────────────────

/** Get (creating if needed) the belief array for a section + subsection. */
function getBeliefs(
  doc: PreviouslyDocument,
  section: Section,
  subsection: ProfileDimension | SelfModelDimension,
): PreviouslyBelief[] {
  const bucket = section === "profile" ? doc.profile : doc.selfModel;
  const arr = (bucket as Record<string, PreviouslyBelief[]>)[subsection];
  if (arr) return arr;
  const created: PreviouslyBelief[] = [];
  (bucket as Record<string, PreviouslyBelief[]>)[subsection] = created;
  return created;
}

/** Find a belief by key phrase match. Returns [index, belief] or [-1, null]. */
function findBelief(
  beliefs: PreviouslyBelief[],
  key: string,
): { index: number; belief: PreviouslyBelief | null } {
  const idx = beliefs.findIndex((b) => b.text.includes(key));
  if (idx === -1) return { index: -1, belief: null };
  return { index: idx, belief: beliefs[idx] };
}

/** Build the refs array from a mutation. */
function buildRefs(m: PreviouslyMutation): string[] {
  const refs: string[] = [];
  if (m.evidence_slice) {
    refs.push(m.evidence_turn ? `${m.evidence_slice}-${m.evidence_turn}` : m.evidence_slice);
  }
  return refs;
}

/** Build a new PreviouslyBelief from a mutation. */
function makeBelief(m: PreviouslyMutation): PreviouslyBelief {
  const shortLived = m.subsection === "current_state" || m.subsection === "boundaries";
  return {
    text: m.belief ?? "",
    refs: buildRefs(m),
    updated: formatDate(),
    confidence: m.new_confidence ?? "medium",
    obs: 1,
    expires: shortLived ? formatExpiry() : undefined,
  };
}

// ── applyObserve ────────────────────────────────────────────────────────

function applyObserve(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief) return false;

  const beliefs = getBeliefs(doc, m.section, m.subsection);

  // Dedup: skip if belief text already exists.
  if (beliefs.some((b) => b.text === m.belief)) return false;

  const belief = makeBelief(m);
  beliefs.push(belief);
  return true;
}

// ── applyReinforce ──────────────────────────────────────────────────────

function applyReinforce(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;

  const beliefs = getBeliefs(doc, m.section, m.subsection);
  const { belief } = findBelief(beliefs, m.belief_key);
  if (!belief) return false;

  belief.obs = (belief.obs ?? 0) + 1;
  belief.updated = formatDate();

  const ref = buildRefs(m)[0];
  if (ref && !belief.refs.includes(ref)) {
    belief.refs.push(ref);
  }

  // Auto-promote confidence: medium→high at obs ≥ 5.
  if (belief.confidence === "medium" && (belief.obs ?? 0) >= 5) {
    belief.confidence = "high";
  }

  return true;
}

// ── applyContradict ─────────────────────────────────────────────────────

function applyContradict(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;

  const beliefs = getBeliefs(doc, m.section, m.subsection);
  const { belief } = findBelief(beliefs, m.belief_key);
  if (!belief) return false;

  // Drop confidence one level (high → medium → low).
  if (belief.confidence === "high") {
    belief.confidence = "medium";
  } else if (belief.confidence === "medium") {
    belief.confidence = "low";
  }
  belief.updated = formatDate();

  // Record what refuted this entry (e.g. a user correction).
  const reason = m.refuted_by ?? m.note;
  if (reason) {
    belief.refuted_by = reason;
  }

  return true;
}

// ── applyRemove (expire + discard) ──────────────────────────────────────

function applyRemove(doc: PreviouslyDocument, m: PreviouslyMutation): number {
  if (!m.belief_key) return 0;

  const beliefs = getBeliefs(doc, m.section, m.subsection);
  const { index } = findBelief(beliefs, m.belief_key);
  if (index === -1) return 0;

  beliefs.splice(index, 1);
  return 1;
}

// ── applyPromote (current_state → stable dimension) ─────────────────────

/**
 * Promote: move an entry from profile.current_state to a stable dimension
 * when its nature changed (keeps recurring → it is a stable trait now).
 */
function applyPromote(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;
  // Promote moves a user-profile current_state entry to a stable profile
  // dimension. Self-model entries have no current_state — a promote there would
  // misplace user context into the agent's operating model.
  if (m.section !== "profile" || m.subsection === "current_state") return false;

  const st = doc.profile.current_state;
  if (!st) return false;

  const { index, belief: oldBelief } = findBelief(st, m.belief_key);
  if (!oldBelief) return false;
  st.splice(index, 1);

  const dest = getBeliefs(doc, m.section, m.subsection);
  const newBelief: PreviouslyBelief = {
    text: m.belief ?? oldBelief.text,
    refs: [...oldBelief.refs],
    confidence: m.new_confidence ?? "medium",
    updated: formatDate(),
    obs: oldBelief.obs ?? 1,
  };
  const ref = buildRefs(m)[0];
  if (ref && !newBelief.refs.includes(ref)) newBelief.refs.push(ref);

  dest.push(newBelief);
  return true;
}

// ── applyDemote (stable dimension → current_state) ──────────────────────

/**
 * Demote: move a stable entry to profile.current_state when it is now just
 * current context (carries a short expiry).
 */
function applyDemote(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;
  // Demote moves a stable profile entry to profile.current_state. A self-model
  // lesson must never land in the user's current state, and there is no
  // self-model current_state bucket to demote into.
  if (m.section !== "profile" || m.subsection === "current_state") return false;

  const src = getBeliefs(doc, m.section, m.subsection);
  const { index, belief: oldBelief } = findBelief(src, m.belief_key);
  if (!oldBelief) return false;
  src.splice(index, 1);

  const st = getBeliefs(doc, "profile", "current_state");
  const newBelief: PreviouslyBelief = {
    text: m.belief ?? oldBelief.text,
    refs: [...oldBelief.refs],
    updated: formatDate(),
    obs: oldBelief.obs,
    expires: formatExpiry(7),
  };
  const ref = buildRefs(m)[0];
  if (ref && !newBelief.refs.includes(ref)) newBelief.refs.push(ref);

  st.push(newBelief);
  return true;
}

// ─── Limit enforcement (profile ≤ 40, self_model ≤ 30) ───────────────────
// Additionally, current_state has its OWN tight cap: it is the short-lived
// section and must not balloon with every turn's "what's happening now"
// entries — otherwise the whole profile fills with expiring ephemera and the
// stable dimensions get starved out.

const LIMITS: Record<Section, number> = {
  profile: 40,
  self_model: 30,
};

/** Hard cap on current_state entries — evicted (weakest first) when exceeded. */
export const CURRENT_STATE_LIMIT = 8;

function beliefScore(b: PreviouslyBelief): number {
  const cs = b.confidence === "high" ? 3 : b.confidence === "medium" ? 2 : 1;

  // Expired short-lived entries are evicted first, regardless of confidence.
  if (b.expires) {
    const exp = new Date(b.expires).getTime();
    if (!Number.isNaN(exp) && exp < Date.now()) {
      return 0;
    }
  }

  // `new Date("")`/`new Date("<garbage>")` return an Invalid Date without
  // throwing, so `.getTime()` can be NaN — guard explicitly rather than with a
  // try/catch that never fires. Unparseable dates fall back to the 30-day
  // default so the score stays a finite number.
  let daysSince = 30;
  const updated = new Date(b.updated);
  if (!Number.isNaN(updated.getTime())) {
    daysSince = Math.max(0, (Date.now() - updated.getTime()) / (24 * 60 * 60 * 1000));
  }
  return cs * (1 / (daysSince + 1));
}

/**
 * Evict the weakest entries across all dimensions of a section until the
 * section total is under its limit. Weakest = lowest confidence × recency.
 */
function enforceTotalLimit(
  section: Partial<Record<ProfileDimension | SelfModelDimension, PreviouslyBelief[]>>,
  limit: number,
): void {
  const dims = Object.keys(section) as Array<ProfileDimension | SelfModelDimension>;
  const total = dims.reduce((n, d) => n + (section[d]?.length ?? 0), 0);
  if (total <= limit) return;

  const all: Array<{ dim: ProfileDimension | SelfModelDimension; idx: number; score: number }> = [];
  for (const dim of dims) {
    const arr = section[dim] ?? [];
    arr.forEach((b, idx) => all.push({ dim, idx, score: beliefScore(b) }));
  }
  all.sort((a, b) => a.score - b.score);

  // Remove the lowest-scoring entries until under limit.
  const toRemove = all.slice(0, total - limit);
  const byDim = new Map<ProfileDimension | SelfModelDimension, number[]>();
  for (const r of toRemove) {
    const list = byDim.get(r.dim) ?? [];
    list.push(r.idx);
    byDim.set(r.dim, list);
  }
  for (const [dim, indices] of byDim) {
    const arr = section[dim] ?? [];
    indices.sort((a, b) => b - a); // remove highest index first
    for (const idx of indices) arr.splice(idx, 1);
  }
}

/**
 * Enforce a per-dimension cap (e.g. current_state ≤ 8) by evicting the
 * weakest entries in that dimension, using the same score as the total limit.
 */
function enforceDimensionLimit(
  section: Partial<Record<ProfileDimension | SelfModelDimension, PreviouslyBelief[]>>,
  dim: ProfileDimension | SelfModelDimension,
  limit: number,
): void {
  const arr = section[dim];
  if (!arr || arr.length <= limit) return;

  const scored = arr
    .map((b, idx) => ({ idx, score: beliefScore(b) }))
    .sort((a, b) => a.score - b.score);
  const toRemove = scored.slice(0, arr.length - limit);
  // Remove highest index first so splicing doesn't shift indices.
  toRemove.sort((a, b) => b.idx - a.idx);
  for (const { idx } of toRemove) arr.splice(idx, 1);
}

function enforceLimits(doc: PreviouslyDocument): void {
  enforceTotalLimit(doc.profile, LIMITS.profile);
  enforceTotalLimit(doc.selfModel, LIMITS.self_model);
  // current_state must never crowd out the stable dimensions with ephemera.
  enforceDimensionLimit(doc.profile, "current_state", CURRENT_STATE_LIMIT);
}
