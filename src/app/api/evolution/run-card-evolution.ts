/**
 * runCardEvolution — the inline, synchronous card-evolution step.
 *
 * v0.7b: evolution no longer runs in a separate parallel workflow fired by the
 * client. It runs synchronously inside the turn's housekeeping step, so the
 * new slice's card is always the freshly-evolved one. This function is the
 * callable core: given the current card + the content to fold in, it runs the
 * Previously Agent (which edits the card through validated MUTATION tools —
 * never a whole-file rewrite), and writes both the live card
 * (current-previously.md) and the per-slice snapshot when the substance moved.
 *
 * There is deliberately NO mechanical post-processing of the agent's output:
 * caps and format are enforced inside the write tools (rejections come back
 * with compression instructions), so every byte of the final card is the
 * agent's own decision. Engineering owns the trigger and the write-back;
 * the model owns the content.
 *
 * v1.0 (design §2.3/§2.7): the run also carries the evolution context
 * (direction.md orientation + the triggered fitness buckets, which gate the
 * agent's writePlaybook), and this function is the SINGLE-WRITER boundary —
 * accepted card/playbook mutations are archived to
 * memory/evolution/mutations.md here, each archival first evaluating the
 * previous mutation on the same target (the effectiveness window). The
 * archive's running tally (effective / ineffective / unevaluated) feeds back
 * into the agent's prompt — the loop's honesty feedback.
 *
 * v1.1 (merged run): at a slice boundary the ONE agent run also evaluates
 * direction.md FIRST (input.directionEval) and may return a
 * `directionProposal` on its finish report. This function validates it
 * (validateDirectionProposal, mode-aware) and applies it through
 * writeDirection + appendMutationWithEvaluation (target "direction") — exactly
 * the old Phase-1 write paths. A rejected proposal is logged and skipped,
 * never fatal; the verdict rides the result's `direction` field for the
 * terminal data-evolution frame.
 *
 * Streaming is surfaced via the optional `onProgress` callback (phase steps)
 * and `onEvolutionLine` (the Previously Agent's live thinking/writing lines)
 * so the caller (housekeeping) can push data-evolution chunks to the client —
 * no idle wait.
 */
import { runPreviouslyAgent, type DirectionEvalInput, type PreviouslySignal } from "@/lib/episodic/flash/previously-agent";
import { parseCard } from "@/lib/episodic/previously-format";
import { sameCardSubstance } from "@/lib/episodic/card-session";
import { diffCardLines, summarizeCardChanges, type CardChangeSummary, type CardMutation } from "@/lib/episodic/card-diff";
import { readCurrentPreviously, writeCurrentPreviously, writePreviously } from "@/lib/episodic";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import type { ModelConfig } from "@/lib/models/registry";
import {
  readFitness,
  readMutations,
  writeDirection,
  writePlaybook,
  type FitnessBucket,
  type FitnessEvent,
  type FitnessSignal,
} from "@/lib/evolution/store";
import type { PlaybookAgent } from "@/lib/evolution/paths";
import {
  appendMutationWithEvaluation,
  mutationTrackRecord,
} from "@/lib/evolution/acceptance";
import { validateDirectionProposal } from "@/lib/evolution/direction-agent";

export interface CardEvolutionReaders {
  readSlice: (sliceId: string, range?: {
    type: "turns" | "last" | "date";
    indices?: number[];
    count?: number;
    after?: string;
  }) => Promise<string>;
  readAgentTimeline: (sliceId: string) => Promise<string>;
  readPreviously: (sliceId: string) => Promise<string>;
}

export interface RunCardEvolutionInput {
  /** The model running the review — the turn's main model (thinking ON, low effort). */
  model: ModelConfig;
  /** The slice whose card is being updated (the closed slice on a boundary). */
  sliceId: string;
  /** When set (slice_closed), enables the deep whole-slice review. */
  closedSliceId?: string;
  /** Recent conversation to evaluate — the closed slice's turns or the active exchange. */
  recentTurns: Array<{ role: string; content: string }>;
  /** Tags on the slice — context for the review. */
  currentSliceTags?: string[];
  /** Previously Agent signal (slice_closed / new_observation / ...). */
  signal?: PreviouslySignal;
  /** For explicit user requests — a hint the review should fold in. */
  focus?: string;
  /** File readers for the agent's deep exploration (past slices / cognition / cards). */
  readers: CardEvolutionReaders;
  /** Progress callback — wire to the turn stream (data-evolution chunks). */
  onProgress?: (step: "reading" | "reviewing" | "applied") => void;
  /**
   * Live thinking/writing lines from the Previously Agent's stream — wire to
   * the turn stream as `data-evolution` live chunks. Unthrottled; the caller
   * throttles.
   */
  onEvolutionLine?: (line: string, stage: "thinking" | "writing") => void;
  /** The owning turn's write batch — card writes join its single commit. */
  batch?: WriteBatch;
  /** The user's local calendar date (YYYY-MM-DD) — Now ages, overdue checks,
   *  and the default `since` all run on the user's clock, not UTC. */
  todayDate?: string;

  // ── Evolution inputs (v1.0 §2.3 / v1.1 merged run) ─────────────────────

  /** The direction half of the merged run (slice boundaries): the agent
   *  evaluates direction.md FIRST and may return a directionProposal, which
   *  THIS function validates and applies. */
  directionEval?: DirectionEvalInput;
  /** Orientation-only direction content (explicit-request path — no direction
   *  evaluation runs there). Ignored when directionEval is set. */
  direction?: string | null;
  /** The fitness buckets that triggered this run — gates writePlaybook. */
  triggeredBuckets?: FitnessBucket[];
  /** Recent fitness events for the triggered buckets (evidence to re-read). */
  fitnessEvents?: FitnessEvent[];
  /** This slice's mechanical signals (recall verify/rework). */
  fitnessSignals?: FitnessSignal[];
}

export interface RunCardEvolutionResult {
  ran: boolean;
  changed: boolean;
  droppedRecent: number;
  note: string;
  /** ONE user-language sentence describing what changed — shown in the
   *  evolution indicator and handed to the core agent. Present when changed. */
  summary?: string;
  /** Line-level mutations vs the previous card — the indicator's expanded diff. */
  mutations?: CardMutation[];
  /** Semantic change counts (added/reinforced/demoted/removed/superseded) —
   *  the indicator's collapsed summary. Present when the card moved. */
  changes?: CardChangeSummary;
  /** Set when the evolution FAILED — never present on a legitimate no-change. */
  error?: string;
  /** Set when the pass ended WITHOUT a finish call (step cap / timeout) — the
   *  written card carries the mutations that landed before the cutoff. */
  partial?: boolean;
  /** v1.0 §2.4: the playbook mutations actually written this run — agent +
   *  the one-line summary from its mutation-archive record (the expected
   *  benefit). Surfaced on the terminal data-evolution frame. */
  playbooks?: Array<{ agent: PlaybookAgent; summary: string }>;
  /** v1.1: the direction half's verdict (merged run only — absent when no
   *  directionEval was carried). "failed" covers a write error; a REJECTED
   *  proposal degrades to "no_change" (logged), mirroring the old Phase-1
   *  discipline. */
  direction?: {
    outcome: "no_change" | "updated" | "failed";
    summary?: string;
  };
}

const VALID_SIGNALS: PreviouslySignal[] = [
  "new_observation",
  "slice_closed",
  "self_reflection",
];

export async function runCardEvolution(
  input: RunCardEvolutionInput,
): Promise<RunCardEvolutionResult> {
  input.onProgress?.("reading");
  const rawCard = await readCurrentPreviously(input.batch);
  const baseCard = rawCard.trim() ? rawCard : "";
  const signal: PreviouslySignal = VALID_SIGNALS.includes(input.signal ?? "new_observation")
    ? (input.signal as PreviouslySignal)
    : "new_observation";

  const note =
    signal === "slice_closed"
      ? `Slice ${input.sliceId} closed — deep review of the whole conversation.` +
        (input.focus ? ` Focus the update on: ${input.focus}` : "")
      : input.focus
        ? `User explicitly requested a memory update: ${input.focus}`
        : "Auto-review of latest conversation.";

  // "reviewing" covers the agent run itself — the phase frame must go out
  // BEFORE it starts (it used to fire after, a ~ms flash before the terminal
  // chunk that left the whole run showing "reading").
  input.onProgress?.("reviewing");
  // The loop's honesty feedback (design §2.7): the agent sees its own
  // mutation track record — an archive full of ineffective mutations should
  // discipline the next proposal. Best-effort; omitted until the first
  // archived mutation.
  let trackRecordLine: string | undefined;
  try {
    const archive = await readMutations();
    if (archive) {
      const rec = mutationTrackRecord(archive);
      if (rec.effective + rec.ineffective + rec.unevaluated > 0) {
        trackRecordLine =
          `Your mutation track record: ${rec.effective} effective / ` +
          `${rec.ineffective} ineffective / ${rec.unevaluated} unevaluated`;
      }
    }
  } catch {
    // The archive is advisory — never block the run on it.
  }
  const result = await runPreviouslyAgent({
    signal,
    note,
    model: input.model,
    currentSliceId: input.sliceId,
    closedSliceId: input.closedSliceId,
    previouslyContent: baseCard,
    recentTurns: input.recentTurns,
    currentSliceTags: input.currentSliceTags,
    todayLocal: input.todayDate,
    direction: input.direction,
    directionEval: input.directionEval,
    triggeredBuckets: input.triggeredBuckets,
    fitnessEvents: input.fitnessEvents,
    fitnessSignals: input.fitnessSignals,
    mutationTrackRecord: trackRecordLine,
    readSliceFn: input.readers.readSlice,
    readAgentTimelineFn: input.readers.readAgentTimeline,
    readPreviouslyFn: input.readers.readPreviously,
    onLine: input.onEvolutionLine,
  });

  // A FAILED worker (unreachable / timed out) must not be presented as
  // "checked, no updates" — surface the failure as an error.
  if (result.failed) {
    return { ran: true, changed: false, droppedRecent: 0, note: result.reasoning, error: result.reasoning };
  }

  // ── v1.1 direction half — the merged run's directionProposal is validated
  // mode-aware and applied through the SAME write paths the old Phase-1 agent
  // used (writeDirection + the mutations archive, target "direction"). A
  // rejected proposal is logged and SKIPPED (never fatal); a write failure is
  // surfaced as outcome "failed", never masquerading as "no_change". ──────
  let directionOutcome: RunCardEvolutionResult["direction"];
  if (input.directionEval) {
    const proposal = result.directionProposal;
    if (!proposal) {
      directionOutcome = { outcome: "no_change" };
    } else {
      const validation = validateDirectionProposal(
        proposal.content,
        input.directionEval.current,
        { mode: input.directionEval.mode },
      );
      if (!validation.ok) {
        console.warn(`[Evolution] direction proposal rejected: ${validation.reason}`);
        directionOutcome = { outcome: "no_change" };
      } else {
        const summary =
          proposal.summary.trim() || "Direction updated (merged evolution run)";
        try {
          const fitnessStore = await readFitness(input.batch);
          await writeDirection(proposal.content.trim(), input.batch);
          const archived = await appendMutationWithEvaluation(
            {
              ts: new Date().toISOString(),
              target: "direction",
              summary,
              evidence: proposal.evidence,
              expectedBenefit:
                proposal.expectedBenefit.trim() || "(none given)",
            },
            fitnessStore,
            input.batch,
          );
          directionOutcome = { outcome: "updated", summary };
          console.log(
            `[Evolution] direction updated: ${summary}` +
              (archived.markedIneffective
                ? ` (previous direction mutation ${archived.evaluatedPreviousTs} marked ineffective)`
                : ""),
          );
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn("[Evolution] direction write failed:", reason);
          directionOutcome = { outcome: "failed", summary: reason };
        }
      }
    }
  }

  // A PARTIAL pass (step limit reached without a finish call) is NOT a
  // failure: the mutations that landed are written back like any other
  // result, with the note flagged so the UI/logs can tell it from a clean
  // finish.
  const resultNote = result.partial ? `[partial] ${result.reasoning}` : result.reasoning;

  if (!result.updatedCard.trim()) {
    return {
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: resultNote,
      ...(result.partial ? { partial: true } : {}),
      ...(directionOutcome ? { direction: directionOutcome } : {}),
    };
  }

  // The agent's session serialized the final card; substance comparison
  // decides whether anything actually moved (stamps refresh on every pass and
  // are ignored). Skip BOTH writes on a no-op pass — writing an unchanged card
  // would produce an empty commit entry for nothing. (The per-slice snapshot
  // is kept fresh by ensurePreviously copying the live card forward each turn.)
  const changed = !sameCardSubstance(parseCard(baseCard), parseCard(result.updatedCard));
  if (changed) {
    // Live card — the next turn's conversation reads this.
    await writeCurrentPreviously(result.updatedCard, input.batch);
    // Per-slice snapshot — the closed slice's final card.
    await writePreviously(input.sliceId, result.updatedCard, input.batch);
  }

  // ── v1.0 §2.7 mutation archive — the evolution agent is the single writer
  // of card / playbooks, and every accepted mutation lands in the append-only
  // archive WITH the effectiveness evaluation of the previous mutation on the
  // same target. Best-effort: an archive failure must never eat the card /
  // playbook write that already landed. ──────────────────────────────────
  const playbookWrites = result.playbookWrites ?? [];
  // The playbooks that actually landed — surfaced on the terminal evolution
  // frame so the UI can tell the "what changed" story (design §2.4).
  const appliedPlaybooks: Array<{ agent: PlaybookAgent; summary: string }> = [];
  if (!result.failed && (changed || playbookWrites.length > 0)) {
    try {
      const fitnessStore = await readFitness(input.batch);
      const ts = new Date().toISOString();
      if (changed) {
        const archived = await appendMutationWithEvaluation(
          {
            ts,
            target: "card",
            summary:
              result.summary.trim() || resultNote.slice(0, 200),
            evidence: [input.sliceId],
            expectedBenefit:
              result.expectedBenefit ?? "Card updated from new evidence",
          },
          fitnessStore,
          input.batch,
        );
        if (archived.markedIneffective) {
          console.log(
            `[Evolution] previous card mutation (${archived.evaluatedPreviousTs}) marked ineffective`,
          );
        }
      }
      for (const pw of playbookWrites) {
        await writePlaybook(pw.agent, pw.content, input.batch);
        // The user-facing line comes from the archived record: the agent's
        // one-line expected benefit, falling back to the archive summary.
        appliedPlaybooks.push({
          agent: pw.agent,
          summary:
            pw.expectedBenefit.trim() || `Rewrote the ${pw.agent} playbook`,
        });
        const archived = await appendMutationWithEvaluation(
          {
            ts,
            target: `playbook:${pw.agent}`,
            summary: `Rewrote the ${pw.agent} playbook (${pw.content.length} chars)`,
            evidence: pw.evidence.length > 0 ? pw.evidence : [input.sliceId],
            expectedBenefit: pw.expectedBenefit || "(none given)",
          },
          fitnessStore,
          input.batch,
        );
        if (archived.markedIneffective) {
          console.log(
            `[Evolution] previous ${pw.agent} playbook mutation (${archived.evaluatedPreviousTs}) marked ineffective`,
          );
        }
      }
    } catch (e) {
      console.warn(
        "[Evolution] mutation archive write failed (the card/playbook writes landed):",
        e instanceof Error ? e.message : e,
      );
    }
  }

  input.onProgress?.("applied");
  return {
    ran: true,
    changed,
    droppedRecent: 0,
    note: resultNote,
    ...(result.partial ? { partial: true } : {}),
    // The agent's own one-sentence account of what changed — only meaningful
    // when the card moved.
    summary: changed && result.summary.trim() ? result.summary.trim() : undefined,
    // The expanded "what changed" diff + the semantic counts — only meaningful
    // when the card moved.
    mutations: changed ? diffCardLines(baseCard, result.updatedCard) : [],
    changes: changed
      ? summarizeCardChanges(baseCard, result.updatedCard, 0)
      : undefined,
    ...(appliedPlaybooks.length > 0 ? { playbooks: appliedPlaybooks } : {}),
    ...(directionOutcome ? { direction: directionOutcome } : {}),
  };
}
