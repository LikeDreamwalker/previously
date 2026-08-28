/**
 * Mutation acceptance rule (v1.0 design §2.7) — the effectiveness window over
 * the append-only mutations archive.
 *
 * The rule is deliberately conservative (the JIT-Agent lineage): a mutation
 * proposal must carry its expected benefit and evidence pointers (enforced by
 * the MutationRecord shape), and every NEW mutation for a target first
 * EVALUATES the previous one on that target — did the corresponding fitness
 * bucket stop losing points after it landed? When the bucket's net score over
 * the events strictly since the previous mutation is still negative, the
 * previous mutation is marked `**Evaluation: ineffective**` in the archive.
 *
 * Append-only discipline: the evaluation is a NEW line appended to
 * mutations.md — history is never rewritten or deleted, and an ineffective
 * mutation stays in the record as a lesson (design §2.7: no rollback, no
 * cooldown, no budget).
 *
 * The evaluation is deterministic and best-effort: a missing/unreadable
 * archive simply means "no previous mutation to evaluate", never an error.
 */
import {
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import { MUTATIONS_PATH } from "./paths";
import {
  appendMutation,
  bucketNetScoreSince,
  type FitnessBucket,
  type FitnessStore,
  type MutationRecord,
  type MutationTarget,
} from "./store";

/**
 * Which fitness bucket observes a target's effectiveness. The direction doc
 * has no bucket of its own — its mutations are judged on the catch-all
 * `interaction` bucket (overall interaction quality is what a direction
 * ultimately steers).
 */
export const TARGET_TO_BUCKET: Record<MutationTarget, FitnessBucket> = {
  direction: "interaction",
  card: "card",
  "playbook:recall": "recall",
  "playbook:search": "search",
  "playbook:thinkdeep": "thinkdeep",
};

/** The marker line appended when a previous mutation proved ineffective. */
export const INEFFECTIVE_MARK = "**Evaluation: ineffective**";

/**
 * Find the most recent archived mutation for a target. The archive format
 * (`## {ts} — {target}`, see renderMutationRecord) is parsed line-wise; the
 * LAST matching heading wins. Pure.
 */
export function findLastMutationForTarget(
  content: string,
  target: MutationTarget,
): { ts: string } | null {
  let found: { ts: string } | null = null;
  for (const line of content.split("\n")) {
    const m = line.match(/^## (.+) — (.+)$/);
    if (m && m[2].trim() === target) found = { ts: m[1].trim() };
  }
  return found;
}

/** Render the append-only evaluation line for an ineffective mutation. */
export function renderIneffectiveEvaluation(
  prevTs: string,
  target: MutationTarget,
  bucket: FitnessBucket,
  net: number,
): string {
  return (
    `- ${INEFFECTIVE_MARK} — ${prevTs} ${target}: the ${bucket} bucket kept ` +
    `scoring negative after this mutation (net ${net} since).`
  );
}

export interface MutationArchiveOutcome {
  /** Ts of the previous mutation on this target that was evaluated, if any. */
  evaluatedPreviousTs: string | null;
  /** True when the previous mutation was marked ineffective. */
  markedIneffective: boolean;
}

/**
 * Archive a newly accepted mutation, evaluating the PREVIOUS mutation on the
 * same target first (design §2.7's observation window):
 *
 *   1. find the previous record for `record.target` in the archive;
 *   2. net-score its bucket over the fitness events strictly SINCE that
 *      record — still negative → append an `**Evaluation: ineffective**`
 *      line (the deductions the mutation meant to stop kept coming);
 *   3. append the new record (via the store's appendMutation).
 *
 * `store` is passed in (not read) so the caller controls freshness — read it
 * AFTER this turn's fitness events landed. Never throws on a missing archive:
 * no previous mutation means nothing to evaluate.
 */
export async function appendMutationWithEvaluation(
  record: MutationRecord,
  store: FitnessStore,
  batch?: WriteBatch,
): Promise<MutationArchiveOutcome> {
  let existing = "";
  try {
    existing = await fsReadFile(MUTATIONS_PATH, batch);
  } catch {
    // No archive yet — nothing to evaluate; appendMutation creates it.
  }

  const prev = existing ? findLastMutationForTarget(existing, record.target) : null;
  let markedIneffective = false;
  if (prev) {
    const bucket = TARGET_TO_BUCKET[record.target];
    const net = bucketNetScoreSince(store, bucket, prev.ts);
    if (net < 0) {
      const line = renderIneffectiveEvaluation(prev.ts, record.target, bucket, net);
      await fsWriteFile(
        MUTATIONS_PATH,
        `${existing.trimEnd()}\n\n${line}\n`,
        batch,
      );
      markedIneffective = true;
    }
  }

  // appendMutation re-reads the archive (batch read-your-writes), so the
  // evaluation line above lands BEFORE the new record in the same commit.
  await appendMutation(record, batch);
  return { evaluatedPreviousTs: prev?.ts ?? null, markedIneffective };
}
