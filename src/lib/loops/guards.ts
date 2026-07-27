/**
 * Pure loop guards — no imports beyond types, so they are safe to call from the
 * deterministic workflow body (which forbids Node.js modules).
 */
import type { LoopStep } from "./types";

/** The comparable core of a loop increment — what stall detection looks at. */
export interface LoopReportLike {
  action: string;
  result: string;
}

/**
 * Normalize a report into comparable text: lowercase, strip punctuation,
 * collapse whitespace to single spaces, trim. Combines action + result so a
 * stall is judged on the whole decision, not just the outcome string.
 */
function normalizeReport(report: LoopReportLike): string {
  return `${report.action} ${report.result}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Word-set Jaccard similarity: |intersection| / |union| of the space-split word
 * sets. Guards division by zero: two empty sets are identical (1); one empty
 * set against a non-empty one shares nothing (0).
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a ? a.split(" ") : []);
  const setB = new Set(b ? b.split(" ") : []);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Stall guard: true when the last 3 reports are near-duplicates of each other.
 *
 * Byte-identical comparison misses real stalls, where a stuck loop re-emits the
 * same decision with a word or two changed (a timestamp, a reworded phrase).
 * Instead we compare normalized action+result text by word-set Jaccard
 * similarity and flag a stall only when ALL THREE pairwise similarities clear a
 * high 0.85 threshold — high enough that genuine progress (which shifts the word
 * set materially) still slips under it.
 */
export function detectNoProgressFromReports(reports: LoopReportLike[]): boolean {
  if (reports.length < 3) return false;
  const [a, b, c] = reports.slice(-3).map(normalizeReport);
  return (
    jaccardSimilarity(a, b) >= 0.85 &&
    jaccardSimilarity(a, c) >= 0.85 &&
    jaccardSimilarity(b, c) >= 0.85
  );
}

/** LoopStep-shaped convenience wrapper over detectNoProgressFromReports. */
export function detectNoProgress(steps: LoopStep[]): boolean {
  return detectNoProgressFromReports(steps);
}
