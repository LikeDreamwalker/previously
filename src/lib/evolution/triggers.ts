/**
 * Evolution trigger computation (v1.0 design §2.5) — the deterministic,
 * code-level half of fitness scoring.
 *
 * The turn-analyzer LLM only ever produces single evidence-anchored deltas
 * (one per slice, per bucket); the AGGREGATION that decides "should evolution
 * run, and focused on which bucket" lives here, in code, so the trigger is
 * reproducible and never a model judgment.
 *
 * GENERATION SEMANTICS (v0.9.2): the fitness store is the CURRENT
 * generation's selection-pressure gauge, not a credit history. A bucket
 * whose generation net drops to EVOLVE_TRIGGER_THRESHOLD or below is under
 * enough environmental pressure that evolution must run NOW. A successful
 * evolution run SETTLES the generation (resetFitnessGeneration clears every
 * bucket's events and signals) — the outcome has already sedimented into the
 * card / direction / playbooks, so the pressure that produced it is spent
 * and must re-accumulate from zero. There is deliberately no cross-
 * generation bookkeeping: evolution has no direction, a mutation is never
 * judged against its predecessor, and nothing rolls back.
 *
 * The rule is ONE number, purely quantitative — no semantic fast paths:
 *
 *   - per bucket: net of the current generation's events ≤ -5 → trigger.
 *     (-2 explicit complaints simply weigh double; +1 approvals offset.)
 *
 * Explicit user instructions ("记住…", "别再…") are NOT selection pressure —
 * they ride the separate memoryUpdate instruction channel.
 *
 * No trigger → NO evolution sub-agent runs. The per-turn "mandatory
 * evolution check" of design §2.3 IS this scoring — mandatory check ≠
 * mandatory mutation.
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
  type FitnessStore,
} from "./store";

/**
 * A bucket at or below this CURRENT-GENERATION net score triggers its own
 * evolution. Calibration: -5 means five weak signals (-1), or two explicit
 * complaints (-2) plus one weak signal — noise never fires it, a sustained
 * pattern does.
 */
export const EVOLVE_TRIGGER_THRESHOLD = -5;

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
 * Compute which buckets trigger evolution on this turn. Purely a function of
 * the store: every event in it is current-generation by construction (a
 * successful evolution run settles the store), so the generation net IS the
 * whole-store net. Call AFTER this turn's fresh deltas were appended (§3a)
 * with a batch-fresh read. Pure.
 */
export function computeEvolutionTriggers(store: FitnessStore): BucketTrigger[] {
  const triggers: BucketTrigger[] = [];
  for (const bucket of FITNESS_BUCKETS) {
    const net = bucketNetScore(store, bucket);
    if (net <= EVOLVE_TRIGGER_THRESHOLD) {
      triggers.push({
        bucket,
        reason: `generation net score ${net} (threshold ${EVOLVE_TRIGGER_THRESHOLD})`,
      });
    }
  }
  return triggers;
}
