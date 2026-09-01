/**
 * Mutation acceptance rule (v1.0 design §2.7) — the effectiveness window over
 * the append-only mutations archive.
 *
 * The rule is deliberately conservative (the JIT-Agent lineage): a mutation
 * proposal must carry its expected benefit and evidence pointers (enforced by
 * the MutationRecord shape), and every NEW mutation for a target first
 * EVALUATES the previous one on that target — did the corresponding fitness
 * bucket stop losing points after it landed? The bucket's net score over the
 * events strictly since the previous mutation decides the append-only verdict
 * line in mutations.md:
 *
 *   - net < 0 → `**Evaluation: ineffective**` (the deductions the mutation
 *     meant to stop kept coming);
 *   - net > 0 → `**Evaluation: effective**` (the signal the mutation meant
 *     to stop did stop — the POSITIVE confirmation, symmetric to the mark);
 *   - net = 0 → no line (inconclusive — no evidence either way).
 *
 * v0.9.1: the verdict requires a MINIMUM OBSERVATION WINDOW (see
 * hasEvaluationWindow) — with the inclusive triggers a follow-up mutation can
 * land minutes after the previous one, and judging it on the same complaint's
 * tail would mark nearly everything ineffective. Too-thin windows leave the
 * record unevaluated, which mutationTrackRecord reports honestly.
 *
 * The archive's running tally (mutationTrackRecord) feeds back into the
 * evolution agent's prompt — the loop's honesty feedback: an agent that
 * keeps writing ineffective mutations should feel it.
 *
 * Append-only discipline: the evaluation is a NEW line appended to
 * mutations.md — history is never rewritten, and an ineffective mutation
 * stays in the record as a lesson (design §2.7: no rollback, no cooldown, no
 * budget). The archive itself is bounded (MAX_MUTATION_RECORDS — oldest
 * records retire on write, v0.9.1).
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

/** The marker line appended when a previous mutation proved effective. */
export const EFFECTIVE_MARK = "**Evaluation: effective**";

/**
 * Minimum observation before judging a previous mutation (v0.9.1): enough
 * scored events must have landed since it OR it must be at least this old.
 * Without the gate, the inclusive ≤ -1 triggers let a follow-up mutation land
 * within minutes and "evaluate" its predecessor on the tail of the very same
 * complaint — marking nearly everything ineffective and poisoning the
 * mutationTrackRecord honesty feedback.
 */
export const MIN_EVALUATION_EVENTS = 10;
export const MIN_EVALUATION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a previous mutation (`sinceTs`, ISO) has been observable long
 * enough to judge: at least MIN_EVALUATION_EVENTS fitness events (any bucket
 * — activity is the sample) strictly newer than it, or it is at least
 * MIN_EVALUATION_AGE_MS old (a quiet day is observation too). Pure.
 */
export function hasEvaluationWindow(
  store: FitnessStore,
  sinceTs: string,
  nowMs = Date.now(),
): boolean {
  const prevMs = Date.parse(sinceTs);
  if (Number.isFinite(prevMs) && nowMs - prevMs >= MIN_EVALUATION_AGE_MS) {
    return true;
  }
  let n = 0;
  for (const e of store.events) if (e.ts > sinceTs) n++;
  return n >= MIN_EVALUATION_EVENTS;
}

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

/** Render the append-only evaluation line for an effective mutation — the
 *  positive confirmation: the signal the mutation meant to stop did stop. */
export function renderEffectiveEvaluation(
  prevTs: string,
  target: MutationTarget,
  bucket: FitnessBucket,
  net: number,
): string {
  return (
    `- ${EFFECTIVE_MARK} — ${prevTs} ${target}: the ${bucket} bucket stopped ` +
    `losing points after this mutation (net +${net} since).`
  );
}

/**
 * The loop's honesty feedback: the archive's running tally. A mutation record
 * (`## {ts} — {target}`) is UNEVALUATED until the next mutation on the same
 * target lands and judges it; the evaluation lines
 * (`- **Evaluation: effective|ineffective** — {ts} {target}: …`) mark their
 * subject record. Pure.
 */
export function mutationTrackRecord(archiveContent: string): {
  effective: number;
  ineffective: number;
  unevaluated: number;
} {
  // Longest-first so "playbook:recall" is tried before a bare prefix could
  // match — targets are a fixed, known set (TARGET_TO_BUCKET's keys).
  const targets = Object.keys(TARGET_TO_BUCKET).sort(
    (a, b) => b.length - a.length,
  ) as MutationTarget[];
  const records: string[] = [];
  const evaluated = new Set<string>();
  let effective = 0;
  let ineffective = 0;
  for (const line of archiveContent.split("\n")) {
    const heading = line.match(/^## (.+) — (.+)$/);
    if (heading) {
      records.push(`${heading[1].trim()} ${heading[2].trim()}`);
      continue;
    }
    const evaluation = line.match(
      /^- \*\*Evaluation: (effective|ineffective)\*\* — (\S+) (.*)$/,
    );
    if (!evaluation) continue;
    if (evaluation[1] === "effective") effective++;
    else ineffective++;
    const rest = evaluation[3];
    const target = targets.find((t) => rest.startsWith(`${t}:`));
    if (target) evaluated.add(`${evaluation[2]} ${target}`);
  }
  return {
    effective,
    ineffective,
    unevaluated: records.filter((r) => !evaluated.has(r)).length,
  };
}

export interface MutationArchiveOutcome {
  /** Ts of the previous mutation on this target that was evaluated, if any. */
  evaluatedPreviousTs: string | null;
  /** True when the previous mutation was marked ineffective. */
  markedIneffective: boolean;
  /** True when the previous mutation was marked effective. */
  markedEffective: boolean;
}

/**
 * Archive a newly accepted mutation, evaluating the PREVIOUS mutation on the
 * same target first (design §2.7's observation window):
 *
 *   1. find the previous record for `record.target` in the archive;
 *   2. net-score its bucket over the fitness events strictly SINCE that
 *      record — but only once the minimum observation window has passed
 *      (hasEvaluationWindow); negative → append an `**Evaluation: ineffective**` line (the
 *      deductions the mutation meant to stop kept coming); positive → append
 *      an `**Evaluation: effective**` line (they stopped); zero → no line
 *      (inconclusive); too-thin window → no line (stays unevaluated);
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
  let markedEffective = false;
  // Too-thin observation window → no verdict: the record stays unevaluated
  // (mutationTrackRecord reports it as such) rather than being judged on the
  // tail of the same complaint that triggered this follow-up mutation.
  if (prev && hasEvaluationWindow(store, prev.ts)) {
    const bucket = TARGET_TO_BUCKET[record.target];
    const net = bucketNetScoreSince(store, bucket, prev.ts);
    const line =
      net < 0
        ? renderIneffectiveEvaluation(prev.ts, record.target, bucket, net)
        : net > 0
          ? renderEffectiveEvaluation(prev.ts, record.target, bucket, net)
          : null; // inconclusive — no line
    if (line) {
      await fsWriteFile(
        MUTATIONS_PATH,
        `${existing.trimEnd()}\n\n${line}\n`,
        batch,
      );
      markedIneffective = net < 0;
      markedEffective = net > 0;
    }
  }

  // appendMutation re-reads the archive (batch read-your-writes), so the
  // evaluation line above lands BEFORE the new record in the same commit.
  await appendMutation(record, batch);
  return { evaluatedPreviousTs: prev?.ts ?? null, markedIneffective, markedEffective };
}
