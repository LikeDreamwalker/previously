/**
 * Evolution trigger computation (v1.0 design §2.5) — the deterministic,
 * code-level half of fitness scoring.
 *
 * The turn-analyzer LLM only ever produces single evidence-anchored deltas
 * (one per slice, per bucket); the AGGREGATION that decides "should evolution
 * run, and focused on which bucket" lives here, in code, so the trigger is
 * reproducible and never a model judgment:
 *
 *   - a bucket whose net score over the newest EVOLVE_WINDOW_SLICES distinct
 *     slices drops to EVOLVE_TRIGGER_THRESHOLD or below → trigger that bucket;
 *   - any evidence-anchored NEGATIVE delta THIS slice → trigger its bucket
 *     immediately: a -2 (an explicit complaint/correction) or a -1 (a
 *     dissatisfaction signal, incl. a portrait-rubric pattern match) both
 *     fire now instead of waiting for the window to fill;
 *   - no trigger → NO evolution sub-agent runs. The per-turn "mandatory
 *     evolution check" of design §2.3 IS this scoring — mandatory check ≠
 *     mandatory mutation.
 *
 * The card bucket's legacy gates (the analyzer's evolve_card.worth, an explicit
 * memory_update, the legacy-card force) are NOT computed here — they need the
 * analysis + card content, so housekeeping combines them with these triggers.
 *
 * Scores are SENSORS, not judges (design §2.5): a trigger only buys a careful
 * re-read of the original evidence by the evolution agent, never a mutation.
 */
import {
  bucketNetScore,
  type FitnessBucket,
  type FitnessEvent,
  type FitnessStore,
} from "./store";

/** A bucket at or below this windowed net score triggers its own evolution. */
export const EVOLVE_TRIGGER_THRESHOLD = -3;

/** Sliding window (distinct slices) the net score is computed over. */
export const EVOLVE_WINDOW_SLICES = 10;

export const FITNESS_BUCKETS: readonly FitnessBucket[] = [
  "card",
  "recall",
  "search",
  "thinkdeep",
  "interaction",
];

/** One fired trigger: which bucket, and the deterministic reason why. */
export interface BucketTrigger {
  bucket: FitnessBucket;
  /** Human/log-readable reason — surfaces in the evolution agent's prompt. */
  reason: string;
}

/**
 * Compute which buckets trigger evolution on this turn. `thisSliceEvents`
 * are THIS slice's freshly scored deltas (pre-store is fine — the evidence
 * rule is re-applied here: an evidence-less delta can never trigger,
 * mirroring appendFitnessEvents' force-zero backstop). Pure.
 */
export function computeEvolutionTriggers(
  store: FitnessStore,
  thisSliceEvents: ReadonlyArray<
    Pick<FitnessEvent, "bucket" | "delta" | "evidence">
  >,
): BucketTrigger[] {
  const triggers: BucketTrigger[] = [];
  for (const bucket of FITNESS_BUCKETS) {
    // Immediate trigger: any evidence-anchored negative delta this slice.
    // The -2 (explicit complaint/correction) is preferred for the reason
    // string when both fired.
    const fresh = thisSliceEvents.filter(
      (e) => e.bucket === bucket && e.delta <= -1 && e.evidence.trim().length > 0,
    );
    const negative = fresh.find((e) => e.delta === -2) ?? fresh[0];
    if (negative) {
      triggers.push({
        bucket,
        reason:
          negative.delta === -2
            ? `explicit complaint/correction this slice: "${negative.evidence.trim().slice(0, 120)}"`
            : `dissatisfaction signal this slice: "${negative.evidence.trim().slice(0, 120)}"`,
      });
      continue;
    }
    // Window trigger: sustained negative net score.
    const net = bucketNetScore(store, bucket, EVOLVE_WINDOW_SLICES);
    if (net <= EVOLVE_TRIGGER_THRESHOLD) {
      triggers.push({
        bucket,
        reason: `net score ${net} over the newest ${EVOLVE_WINDOW_SLICES} slices (threshold ${EVOLVE_TRIGGER_THRESHOLD})`,
      });
    }
  }
  return triggers;
}
