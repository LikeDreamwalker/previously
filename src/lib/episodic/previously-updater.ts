/**
 * Previously Updater — pure functions that apply Previously Agent mutations
 * to a previously.md body string.
 *
 * All functions are pure: string in, string out. No I/O, no LLM calls.
 *
 * Supports 7 mutation actions across the long/short-term split:
 *   - observe   : add a new belief
 *   - reinforce : bump obs count and update last-seen date
 *   - contradict: drop confidence, add contradiction note
 *   - discard   : remove the belief
 *   - expire    : remove an expired short-term belief
 *   - promote   : move belief from short-term → long-term
 *   - demote    : move belief from long-term → short-term
 */

import type { PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";
import {
  parsePreviously,
  serializePreviously,
  formatDate,
  formatExpiry,
  type PreviouslyBelief,
  type PreviouslyDocument,
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
}

/**
 * Apply a batch of PreviouslyAgent mutations to a previously.md body.
 * Returns the updated content + a summary of changes.
 */
export function applyPreviouslyAgentOutput(
  content: string,
  mutations: PreviouslyMutation[],
  currentSliceId: string,
): ApplyResult {
  if (!mutations.length) {
    // Still enforce limits — the document may have been externally modified.
    const doc = parsePreviously(content);
    if (doc) {
      enforceLimits(doc);
      return {
        content: serializePreviously(doc),
        changes: { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 },
      };
    }
    return {
      content,
      changes: { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 },
    };
  }

  // Parse current content. If unparseable, start from template.
  let doc = parsePreviously(content);
  if (!doc) {
    doc = {
      sliceId: currentSliceId,
      updated: new Date().toISOString(),
      longTerm: { identity: [], patterns: [], strategies: [] },
      shortTerm: { context: [] },
    };
  }

  doc.updated = new Date().toISOString();
  if (currentSliceId) doc.sliceId = currentSliceId;

  const changes: ApplyResult["changes"] = {
    added: 0,
    reinforced: 0,
    demoted: 0,
    removed: 0,
    superseded: 0,
  };

  // Sanitize mutations: fill missing evidence (creates copies to avoid mutating caller's data)
  const currentSlicePath = currentSliceId.replace(/-/g, "/");
  const sanitized = mutations.map((m) =>
    !m.evidence_slice || m.evidence_slice === "undefined"
      ? { ...m, evidence_slice: currentSlicePath }
      : m,
  );

  // Use sanitized copies throughout
  mutations = sanitized;

  // Separate mutations by type for ordered processing
  const expires = mutations.filter((m) => m.action === "expire");
  const discards = mutations.filter((m) => m.action === "discard");
  const contradicts = mutations.filter((m) => m.action === "contradict");
  const reinforces = mutations.filter((m) => m.action === "reinforce");
  const observes = mutations.filter((m) => m.action === "observe");
  const promotes = mutations.filter((m) => m.action === "promote");
  const demotes = mutations.filter((m) => m.action === "demote");

  // Process in order: remove first, then modify, then add
  for (const m of [...expires, ...discards]) {
    const removed = applyRemove(doc, m);
    changes.removed += removed;
  }

  for (const m of contradicts) {
    const done = applyContradict(doc, m);
    if (done) changes.demoted += 1; // contradiction = confidence demotion
  }

  for (const m of reinforces) {
    const done = applyReinforce(doc, m);
    if (done) changes.reinforced += 1;
  }

  for (const m of demotes) {
    const done = applyDemote(doc, m);
    if (done) changes.demoted += 1;
  }

  for (const m of promotes) {
    const done = applyPromote(doc, m);
    if (done) changes.added += 1;
  }

  for (const m of observes) {
    const added = applyObserve(doc, m);
    changes.added += added ? 1 : 0;
  }

  // Enforce quantity limits (R13)
  enforceLimits(doc);

  return {
    content: serializePreviously(doc),
    changes,
  };
}

// ─── Action helpers ─────────────────────────────────────────────────────

/** Get the belief array for a given tier + subsection. */
function getBeliefs(
  doc: PreviouslyDocument,
  tier: "long" | "short",
  subsection: "identity" | "patterns" | "strategies" | "context",
): PreviouslyBelief[] {
  if (tier === "short" || subsection === "context") {
    return doc.shortTerm.context;
  }
  return doc.longTerm[subsection];
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

/** Build a new PreviouslyBelief from a mutation. */
function makeBelief(m: PreviouslyMutation): PreviouslyBelief {
  const isShort = m.tier === "short" || m.subsection === "context";
  return {
    text: m.belief ?? "",
    evidence: m.evidence_slice && m.evidence_turn
      ? [`${m.evidence_slice}-${m.evidence_turn}`]
      : (m.evidence_slice ? [m.evidence_slice] : []),
    updated: formatDate(),
    confidence: m.new_confidence ?? (isShort ? undefined : "medium"),
    obs: 1,
    expires: isShort
      ? (m.action === "demote" ? formatExpiry(3) : formatExpiry())
      : undefined,
  };
}

// ── applyObserve ────────────────────────────────────────────────────────

function applyObserve(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief) return false;

  const beliefs = getBeliefs(doc, m.tier, m.subsection);

  // Dedup: skip if belief text already exists
  if (beliefs.some((b) => b.text === m.belief)) return false;

  const belief = makeBelief(m);
  beliefs.push(belief);
  return true;
}

// ── applyReinforce ──────────────────────────────────────────────────────

function applyReinforce(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;

  const beliefs = getBeliefs(doc, m.tier, m.subsection);
  const { index, belief } = findBelief(beliefs, m.belief_key);
  if (!belief) return false;

  // Bump obs
  belief.obs = (belief.obs ?? 0) + 1;
  belief.updated = formatDate();

  // Add evidence if provided
  if (m.evidence_slice && m.evidence_turn) {
    const ref = `${m.evidence_slice}-${m.evidence_turn}`;
    if (!belief.evidence.includes(ref)) {
      belief.evidence.push(ref);
    }
  }

  // Auto-promote confidence: medium→high at obs ≥ 5 (long-term only)
  if (m.tier === "long" && belief.confidence === "medium" && belief.obs >= 5) {
    belief.confidence = "high";
  }

  return true;
}

// ── applyContradict ─────────────────────────────────────────────────────

function applyContradict(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;

  const beliefs = getBeliefs(doc, m.tier, m.subsection);
  const { belief } = findBelief(beliefs, m.belief_key);
  if (!belief) return false;

  // Drop confidence one level
  if (belief.confidence === "high") {
    belief.confidence = "medium";
  } else if (belief.confidence === "medium") {
    belief.confidence = "low";
  }
  // low stays low
  belief.updated = formatDate();

  // Add contradiction note as a comment appended to the text
  if (m.note) {
    belief.text = `${belief.text} <!-- ⚠️ ${m.note} -->`;
  }

  return true;
}

// ── applyRemove (expire + discard) ──────────────────────────────────────

function applyRemove(doc: PreviouslyDocument, m: PreviouslyMutation): number {
  if (!m.belief_key) return 0;

  const beliefs = getBeliefs(doc, m.tier, m.subsection);
  const { index } = findBelief(beliefs, m.belief_key);
  if (index === -1) return 0;

  beliefs.splice(index, 1);
  return 1;
}

// ── applyPromote (short → long) ─────────────────────────────────────────

/**
 * Promote a short-term belief to long-term.
 * R6: Short-term item referenced in 3+ slices → promote to long-term.
 * Source is always shortTerm.context. Destination is longTerm[m.subsection].
 */
function applyPromote(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key || !m.belief) return false;

  // Remove from short-term
  const stBeliefs = doc.shortTerm.context;
  const { index, belief: oldBelief } = findBelief(stBeliefs, m.belief_key);
  if (!oldBelief) return false;
  stBeliefs.splice(index, 1);

  // Determine destination subsection
  const destSubsection = m.subsection === "context" ? "patterns" : m.subsection;
  const ltBeliefs = doc.longTerm[destSubsection];

  const newBelief: PreviouslyBelief = {
    text: m.belief,
    evidence: [...oldBelief.evidence],
    confidence: m.new_confidence ?? "medium",
    updated: formatDate(),
    obs: oldBelief.obs ?? 3,
  };
  // Add new evidence
  if (m.evidence_slice && m.evidence_turn) {
    const ref = `${m.evidence_slice}-${m.evidence_turn}`;
    if (!newBelief.evidence.includes(ref)) {
      newBelief.evidence.push(ref);
    }
  }
  ltBeliefs.push(newBelief);
  return true;
}

// ── applyDemote (long → short) ──────────────────────────────────────────

/**
 * Demote a long-term belief to short-term.
 * R12: Long-term belief with confidence:low AND obs:1 → demote to short-term.
 * R7: Long-term item with no new evidence → demote confidence.
 *
 * Full demote (m.belief provided): search ALL long-term subsections for the
 * belief_key, then move to shortTerm.context.
 * Confidence-only (no m.belief): use m.subsection to locate the belief in
 * place and drop confidence.
 */
const LONG_TERM_SUBSECTIONS: Array<"identity" | "patterns" | "strategies"> = [
  "identity", "patterns", "strategies",
];

function applyDemote(doc: PreviouslyDocument, m: PreviouslyMutation): boolean {
  if (!m.belief_key) return false;

  // Full demote: search all long-term subsections, move to short-term
  if (m.belief) {
    for (const sub of LONG_TERM_SUBSECTIONS) {
      const ltBeliefs = doc.longTerm[sub];
      const { index, belief: oldBelief } = findBelief(ltBeliefs, m.belief_key);
      if (!oldBelief) continue;

      ltBeliefs.splice(index, 1);

      const stBelief: PreviouslyBelief = {
        text: m.belief,
        evidence: [...oldBelief.evidence],
        updated: formatDate(),
        expires: formatExpiry(3), // short expiry for demoted items
        obs: oldBelief.obs,
      };
      doc.shortTerm.context.push(stBelief);
      return true;
    }
    return false;
  }

  // Confidence-only demote: use the subsection to find the belief in place
  const beliefs = getBeliefs(doc, m.tier, m.subsection);
  const { belief } = findBelief(beliefs, m.belief_key);
  if (!belief || !belief.confidence) return false;

  if (m.new_confidence) {
    belief.confidence = m.new_confidence;
  } else if (belief.confidence === "high") {
    belief.confidence = "medium";
  } else if (belief.confidence === "medium") {
    belief.confidence = "low";
  }
  belief.updated = formatDate();
  return true;
}

// ─── Limit enforcement (R13) ───────────────────────────────────────────

const LIMITS: Record<string, number> = {
  identity: 20,
  patterns: 8,
  strategies: 15,
  context: 10,
};

function confidenceScore(c: "high" | "medium" | "low" | undefined): number {
  switch (c) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 1;
  }
}

function enforceLimits(doc: PreviouslyDocument): void {
  enforceSectionLimit(doc.longTerm.identity, LIMITS.identity);
  enforceSectionLimit(doc.longTerm.patterns, LIMITS.patterns);
  enforceSectionLimit(doc.longTerm.strategies, LIMITS.strategies);
  enforceSectionLimit(doc.shortTerm.context, LIMITS.context);
}

function enforceSectionLimit(beliefs: PreviouslyBelief[], limit: number): void {
  if (beliefs.length <= limit) return;

  // Sort by score ascending, remove lowest first
  const scored = beliefs.map((b, i) => {
    const cs = confidenceScore(b.confidence);
    // recency: days since updated
    let daysSince = 30;
    try {
      const updated = new Date(b.updated);
      daysSince = Math.max(0, (Date.now() - updated.getTime()) / (24 * 60 * 60 * 1000));
    } catch { /* use default */ }
    const recency = 1 / (daysSince + 1);
    return { index: i, score: cs * recency };
  });

  scored.sort((a, b) => a.score - b.score);

  // Remove lowest-scoring items until under limit
  const toRemove = scored.slice(0, beliefs.length - limit).map((s) => s.index);
  // Remove in reverse order to preserve indices
  for (const idx of toRemove.sort((a, b) => b - a)) {
    beliefs.splice(idx, 1);
  }
}
