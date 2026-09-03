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
 * accepted card/playbook/direction writes land here. Evolution has no
 * direction and no fossil archive (v0.9.2): a mutation is never judged
 * against its predecessor and nothing rolls back.
 *
 * v1.1 (merged run): at a slice boundary the ONE agent run also evaluates
 * direction.md FIRST (input.directionEval) and edits a working copy through
 * ATOMIC direction mutation ops. This function gates the resulting doc
 * (validateDirectionProposal, mode-aware), retires expired hypotheses
 * deterministically (retireExpiredHypotheses — the pool TTL is engineering's
 * half of the lifecycle, and it runs even on a no-change verdict), and
 * applies through writeDirection — the old Phase-1 write path. A rejected
 * doc is logged and skipped, never fatal; the verdict rides the result's
 * `direction` field for the terminal data-evolution frame.
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
import { readCurrentPreviously, writeCurrentPreviously, writePreviously, readTimelineIndex } from "@/lib/episodic";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import type { ModelConfig } from "@/lib/models/registry";
import {
  writeDirection,
  writePlaybook,
  type FitnessBucket,
  type FitnessEvent,
  type FitnessSignal,
} from "@/lib/evolution/store";
import type { PlaybookAgent } from "@/lib/evolution/paths";
import { validateDirectionProposal, retireExpiredHypotheses } from "@/lib/evolution/direction-agent";

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
   *  evaluates direction.md FIRST and edits a working copy through atomic
   *  mutation ops; the resulting doc is validated and applied HERE. */
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
   *  proposal reports outcome "rejected" with the validation reason (never
   *  masquerading as "no_change" — the caller backs the gate off for the rest
   *  of the slice on a rejection, see housekeeping). */
  direction?: {
    outcome: "no_change" | "updated" | "failed" | "rejected";
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

  // ── v1.1 direction half — the merged run edits direction.md through ATOMIC
  // mutation ops (per-op validation in applyDirectionOps; `proposed` pointers
  // code-stamped). The resulting doc still passes the whole-doc gate here
  // (validateDirectionProposal, mode-aware) and the engineering TTL
  // (retireExpiredHypotheses) before writeDirection. A rejected doc is logged
  // and SKIPPED (never fatal); a write failure is surfaced as outcome
  // "failed", never masquerading as "no_change". The TTL also runs on a
  // NO-CHANGE verdict — expiry is engineering's, not the agent's. ──────────
  let directionOutcome: RunCardEvolutionResult["direction"];
  if (input.directionEval) {
    const currentDir = input.directionEval.current;
    const idx = await readTimelineIndex().catch(() => null);
    const sliceIds = [...(idx?.slices ?? []).map((s) => s.id), input.sliceId];
    const proposal = result.direction;
    if (!proposal) {
      // No agent move — engineering still retires expired hypotheses.
      if (currentDir?.trim()) {
        const aged = retireExpiredHypotheses(currentDir.trim(), sliceIds);
        if (aged.retired.length > 0) {
          try {
            await writeDirection(aged.doc, input.batch);
            directionOutcome = {
              outcome: "updated",
              summary: `Retired ${aged.retired.length} expired hypothesis(es)`,
            };
            console.log(
              `[Evolution] direction: retired ${aged.retired.length} expired hypothesis(es) (no-change run)`,
            );
          } catch (e) {
            console.warn(
              "[Evolution] direction TTL write failed:",
              e instanceof Error ? e.message : e,
            );
          }
        }
      }
      if (!directionOutcome) directionOutcome = { outcome: "no_change" };
    } else {
      const validation = validateDirectionProposal(
        proposal.doc,
        currentDir,
        { mode: input.directionEval.mode },
      );
      if (!validation.ok) {
        // A rejection is NOT "no_change": the doc keeps its old skeleton, so
        // the migrate/bootstrap gate would otherwise re-fire the full merged
        // run on EVERY remaining turn of this slice. The distinct outcome lets
        // housekeeping back the gate off (per-slice) and lets the terminal
        // frame show the rejection instead of a fake "checked, unchanged".
        console.warn(`[Evolution] direction proposal rejected: ${validation.reason}`);
        directionOutcome = { outcome: "rejected", summary: validation.reason };
      } else {
        const summary =
          proposal.summary.trim() || "Direction updated (merged evolution run)";
        try {
          const aged = retireExpiredHypotheses(proposal.doc.trim(), sliceIds);
          if (aged.retired.length > 0) {
            console.log(
              `[Evolution] direction: retired ${aged.retired.length} expired hypothesis(es)`,
            );
          }
          await writeDirection(aged.doc, input.batch);
          directionOutcome = { outcome: "updated", summary };
          console.log(`[Evolution] direction updated: ${summary}`);
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

  // ── Playbook write-back — the evolution agent is the single writer of
  // card / playbooks. The playbooks that actually landed are surfaced on the
  // terminal evolution frame so the UI can tell the "what changed" story
  // (design §2.4). ────────────────────────────────────────────────────────
  const playbookWrites = result.playbookWrites ?? [];
  const appliedPlaybooks: Array<{ agent: PlaybookAgent; summary: string }> = [];
  if (!result.failed) {
    try {
      for (const pw of playbookWrites) {
        await writePlaybook(pw.agent, pw.content, input.batch);
        appliedPlaybooks.push({
          agent: pw.agent,
          summary:
            pw.expectedBenefit.trim() || `Rewrote the ${pw.agent} playbook`,
        });
      }
    } catch (e) {
      console.warn(
        "[Evolution] playbook write failed (the card write landed):",
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
