/**
 * Line-level diff between two card revisions — the "what actually changed"
 * payload the evolution indicator expands to — plus the semantic change
 * summary (added / reinforced / demoted / removed / superseded) shown in the
 * indicator's collapsed summary.
 *
 * Cards are small structured markdown. `diffCardLines` is a set-based line
 * comparison: lines present only in the new revision are "added", only in the
 * old are "removed". Blank lines and scaffold lines (the title, the
 * `_Active slice: …_` stamp, `## ` section headings — the stamp refreshes on
 * every pass and would otherwise pollute the diff) are ignored; duplicates
 * collapse; order follows each side's document order (removed first, then
 * added — the conventional diff reading).
 *
 * `summarizeCardChanges` parses both revisions into card documents and maps
 * the v5 card semantics onto the five counters:
 *   added      — brand-new entries
 *   removed    — entries the agent deleted outright
 *   superseded — an entry rewritten in place (a removed line paired with a
 *                similar added line)
 *   reinforced — the rolling Past profile paragraph updated in place
 *   demoted    — Now items aged out by the mechanical 7-day expiry
 */

import { parseCard, type CardDocument } from "./previously-format";

export interface CardMutation {
  type: "added" | "removed";
  text: string;
}

export interface CardChangeSummary {
  added: number;
  reinforced: number;
  demoted: number;
  removed: number;
  superseded: number;
}

/** Cap per side so a pathological full rewrite can't flood the stream/UI. */
const MAX_MUTATIONS_PER_SIDE = 12;

/** Title / stamp / section-heading lines carry no substance — skip them. */
function isScaffoldLine(line: string): boolean {
  return (
    line.startsWith("#") || line.startsWith("_") || line.startsWith("<!--")
  );
}

export function diffCardLines(before: string, after: string): CardMutation[] {
  const beforeLines = before
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isScaffoldLine(l));
  const afterLines = after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isScaffoldLine(l));
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  const mutations: CardMutation[] = [];
  const seen = new Set<string>();
  for (const text of beforeLines) {
    if (afterSet.has(text) || seen.has(text)) continue;
    seen.add(text);
    mutations.push({ type: "removed", text });
    if (mutations.length >= MAX_MUTATIONS_PER_SIDE) break;
  }
  seen.clear();
  let added = 0;
  for (const text of afterLines) {
    if (beforeSet.has(text) || seen.has(text)) continue;
    seen.add(text);
    mutations.push({ type: "added", text });
    if (++added >= MAX_MUTATIONS_PER_SIDE) break;
  }
  return mutations;
}

// ─── Semantic change summary ────────────────────────────────────────────────

/** Word-token similarity: enough overlap → the same entry, rewritten. */
function tokenSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const sa = tok(a);
  const sb = tok(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const jaccard = inter / (sa.size + sb.size - inter);
  const containment = inter / Math.min(sa.size, sb.size);
  return Math.max(jaccard, containment);
}

const REWRITE_THRESHOLD = 0.5;

/**
 * Pair removed lines with similar added lines (greedy best-match) — those are
 * rewrites, not independent add/remove events. Returns the leftover counts.
 */
function countSetChanges(
  beforeLines: string[],
  afterLines: string[],
): { added: number; removed: number; superseded: number } {
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = [...new Set(beforeLines.filter((l) => !afterSet.has(l)))];
  const added = [...new Set(afterLines.filter((l) => !beforeSet.has(l)))];

  const usedAdded = new Set<number>();
  let superseded = 0;
  for (const r of removed) {
    let best = -1;
    let bestScore = REWRITE_THRESHOLD;
    for (let i = 0; i < added.length; i++) {
      if (usedAdded.has(i)) continue;
      const score = tokenSimilarity(r, added[i]);
      if (score >= bestScore) {
        best = i;
        bestScore = score;
      }
    }
    if (best !== -1) {
      usedAdded.add(best);
      superseded += 1;
    }
  }
  return {
    added: added.length - usedAdded.size,
    removed: removed.length - superseded,
    superseded,
  };
}

/** Entry lines per card section (now items compare by text only). */
function entryLines(doc: CardDocument): {
  identity: string[];
  now: string[];
  horizon: string[];
  anchors: string[];
  selfModel: string[];
} {
  return {
    identity: doc.identity,
    now: doc.now.map((r) => r.text),
    horizon: doc.horizon.map((h) => h.text),
    anchors: doc.past.anchors.map((a) => a.text),
    selfModel: doc.selfModel,
  };
}

/**
 * Summarize a card rewrite into the five indicator counters. Falls back to the
 * plain line diff when either side doesn't parse as a card. `droppedRecent`
 * (the mechanical 7-day expiry count from the updater) is reported as demoted
 * and excluded from the agent-authored removed count.
 */
export function summarizeCardChanges(
  before: string,
  after: string,
  droppedRecent = 0,
): CardChangeSummary {
  const prevDoc = parseCard(before);
  const nextDoc = parseCard(after);
  if (!prevDoc || !nextDoc) {
    // Non-card content — line-diff counts only.
    const lines = countSetChanges(
      before.split("\n").map((l) => l.trim()).filter((l) => l && !isScaffoldLine(l)),
      after.split("\n").map((l) => l.trim()).filter((l) => l && !isScaffoldLine(l)),
    );
    return { ...lines, reinforced: 0, demoted: droppedRecent };
  }

  const prev = entryLines(prevDoc);
  const next = entryLines(nextDoc);
  const sum: CardChangeSummary = {
    added: 0,
    reinforced: 0,
    demoted: droppedRecent,
    removed: 0,
    superseded: 0,
  };

  for (const key of ["identity", "now", "horizon", "anchors", "selfModel"] as const) {
    const c = countSetChanges(prev[key], next[key]);
    sum.added += c.added;
    sum.removed += c.removed;
    sum.superseded += c.superseded;
  }
  // Expired Now items also show up as removed lines — don't double-count.
  sum.removed = Math.max(0, sum.removed - droppedRecent);

  // The rolling Past profile paragraph: rewritten in place = reinforced;
  // appearing from nothing = added; dropped entirely = removed.
  const pBefore = prevDoc.past.profile.trim();
  const pAfter = nextDoc.past.profile.trim();
  if (pBefore !== pAfter) {
    if (!pBefore) sum.added += 1;
    else if (!pAfter) sum.removed += 1;
    else sum.reinforced = 1;
  }

  return sum;
}
