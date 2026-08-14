/**
 * runCardEvolution — the inline, synchronous card-evolution step.
 *
 * v0.7b: evolution no longer runs in a separate parallel workflow fired by the
 * client. It runs synchronously inside the turn's housekeeping step, so the
 * new slice's card is always the freshly-evolved one. This function is the
 * callable core: given the current card + the content to fold in, it runs the
 * Previously Agent, applies the updated card with mechanical enforcement, and
 * writes both the live card (current-previously.md) and the per-slice snapshot.
 *
 * Streaming is surfaced via the optional `onProgress` callback so the caller
 * (housekeeping) can push data-evolution chunks to the client — no idle wait.
 */
import { runPreviouslyAgent, type PreviouslySignal } from "@/lib/episodic/flash/previously-agent";
import { applyCardUpdate } from "@/lib/episodic/previously-updater";
import { diffCardLines, summarizeCardChanges, type CardChangeSummary, type CardMutation } from "@/lib/episodic/card-diff";
import { readCurrentPreviously, writeCurrentPreviously, writePreviously } from "@/lib/episodic";
import type { ModelConfig } from "@/lib/models/registry";

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
  /** The worker model running the review (thinking off). */
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
}

export interface RunCardEvolutionResult {
  ran: boolean;
  changed: boolean;
  droppedRecent: number;
  note: string;
  /** Line-level mutations vs the previous card — the indicator's expanded diff. */
  mutations?: CardMutation[];
  /** Semantic change counts (added/reinforced/demoted/removed/superseded) —
   *  the indicator's collapsed summary. Present when the card moved. */
  changes?: CardChangeSummary;
  /** Set when the evolution FAILED — never present on a legitimate no-change. */
  error?: string;
}

const VALID_SIGNALS: PreviouslySignal[] = [
  "new_observation",
  "user_correction",
  "slice_closed",
  "self_reflection",
];

export async function runCardEvolution(
  input: RunCardEvolutionInput,
): Promise<RunCardEvolutionResult> {
  const rawCard = await readCurrentPreviously();
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

  input.onProgress?.("reading");
  const result = await runPreviouslyAgent({
    signal,
    note,
    model: input.model,
    currentSliceId: input.sliceId,
    closedSliceId: input.closedSliceId,
    previouslyContent: baseCard,
    agentCognition: "",
    recentTurns: input.recentTurns,
    currentSliceTags: input.currentSliceTags,
    readSliceFn: input.readers.readSlice,
    readAgentTimelineFn: input.readers.readAgentTimeline,
    readPreviouslyFn: input.readers.readPreviously,
  });

  input.onProgress?.("reviewing");

  // A FAILED worker (unreachable / schema-invalid / no output call) must not be
  // presented as "checked, no updates" — surface the failure as an error.
  if (result.failed) {
    return { ran: true, changed: false, droppedRecent: 0, note: result.reasoning, error: result.reasoning };
  }

  if (!result.updatedCard.trim()) {
    return { ran: true, changed: false, droppedRecent: 0, note: result.reasoning };
  }

  const applied = applyCardUpdate(baseCard, result.updatedCard, input.sliceId);
  // Live card — the next turn's conversation reads this.
  await writeCurrentPreviously(applied.content);
  // Per-slice snapshot — the closed slice's final card.
  await writePreviously(input.sliceId, applied.content);

  input.onProgress?.("applied");
  return {
    ran: true,
    changed: applied.changed,
    droppedRecent: applied.droppedRecent,
    note: result.reasoning,
    // The expanded "what changed" diff + the semantic counts — only meaningful
    // when the card moved.
    mutations: applied.changed ? diffCardLines(baseCard, applied.content) : [],
    changes: applied.changed
      ? summarizeCardChanges(baseCard, applied.content, applied.droppedRecent)
      : undefined,
  };
}
