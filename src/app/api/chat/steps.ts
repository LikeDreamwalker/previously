/**
 * Chat turn step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (gray-matter + fs, the episodic manager) never enter the deterministic
 * workflow sandbox. `turn-workflow.ts` imports these `"use step"` functions
 * by reference only; the loader compiles them into the step bundle, not the
 * workflow bundle.
 *
 * Steps:
 *   1. housekeeping  — recover/close/create slice, append user turn, open UI stream
 *   2. seedPreviously — copy previously.md forward to new slice (mechanical, no LLM)
 *   3. finalizeTurn  — persist agent turn, close UI stream
 *
 * Chunk order for the UI: start → start-step → data-phase(slicing) → finish-step → finish.
 */
import { type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import {
  createSlice,
  closeSlice,
  appendTurn,
  saveSliceSnapshot,
  ensureIndexEntries,
  tryLoadTodaySlice,
  writeAgentTimeline,
  ensurePreviously,
  readPreviously,
  generateGlobalTimeline,
  type TimeSlice,
} from "@/lib/episodic";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import type {
  TurnInput,
  HousekeepingResult,
  TurnOutcome,
} from "@/lib/chat/turn-types";


// ─── Step 1: Housekeeping ────────────────────────────────────────────────

/**
 * Recover today's slice from GitHub truth (never the module global — it does
 * not survive across workflow invocations), close it on time-silence / turn
 * cap, or create a fresh one. Append the user turn and durably snapshot before
 * returning, so the message is on GitHub before we stream anything.
 */
export async function housekeeping(input: TurnInput): Promise<HousekeepingResult> {
  "use step";

  // Phase start — show spinner in UI
  const phaseWriter0 = getWritable<UIMessageChunk>().getWriter();
  await phaseWriter0.write({
    type: "data-phase" as `data-${string}`,
    id: "phase-prepare",
    data: { phase: "slicing", running: true },
  } as UIMessageChunk);
  phaseWriter0.releaseLock();

  const { config, clientTimezone, lastUserMessage } = input;
  const silenceMs = config.slicing.timeSilenceMinutes * 60 * 1000;

  let slice: TimeSlice;
  let closedSlice: TimeSlice | undefined;
  const diskSlice = await tryLoadTodaySlice();

  if (diskSlice && diskSlice.status === "active") {
    const lastTurn = diskSlice.turns[diskSlice.turns.length - 1];
    const lastActivity = lastTurn
      ? new Date(lastTurn.timestamp).getTime()
      : Date.now();

    if (checkTimeSilence(lastActivity, silenceMs)) {
      await closeSlice(diskSlice, "time_silence");
      console.log(`[Episodic] Recovered & closed stale slice: ${diskSlice.slice_id}`);
      await generateGlobalTimeline();
      closedSlice = diskSlice;
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      // Force-close on turn count (safety net for marathon sessions).
      await closeSlice(diskSlice, "capacity");
      console.log(`[Episodic] Closed at turn cap: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
      await generateGlobalTimeline();
      closedSlice = diskSlice;
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else {
      slice = diskSlice;
      console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
    }
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
  }

  // Append the user message (skip if createSlice already seeded it as turn 1).
  const isNewSlice =
    slice.turns.length === 1 && slice.turns[0].content === lastUserMessage;
  if (!isNewSlice) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "user",
      content: lastUserMessage,
      turnId: input.turnId,
    });
  }

  // Durable snapshot BEFORE streaming (was fire-and-forget in the inline route):
  // guarantees the user turn is on GitHub, and that the next turn's
  // tryLoadTodaySlice sees it even if the agent never finishes.
  await saveSliceSnapshot(slice);
  await ensureIndexEntries(slice);
  await generateGlobalTimeline();

  // Open the UI message stream. Lifecycle chunks are written INTO the durable
  // run stream (not injected by the route transform) so the POST path and the
  // reconnect path replay identical chunk sequences — WorkflowChatTransport
  // resumes by chunk index, which must line up across both.
  const writer = getWritable<UIMessageChunk>().getWriter();
  await writer.write({ type: "start" } as UIMessageChunk);
  await writer.write({ type: "start-step" } as UIMessageChunk);
  await writer.write({
    type: "data-phase" as `data-${string}`,
    id: "phase-prepare",
    data: { phase: "slicing", running: false },
  } as UIMessageChunk);
  writer.releaseLock();

  return { slice, closedSlice };
}

// ─── Step 2: Seed previously.md (mechanical) ────────────────────────────────

/**
 * Pure file copy — no LLM. Copies the most recent previously.md forward to
 * the new slice via ensurePreviously(). If a slice just closed and was deep-
 * reviewed by the Previously Agent (called via updatePreviously tool), the
 * enriched version is automatically picked up.
 */
export async function seedPreviously(
  currentSliceId: string,
  _closedSliceId?: string,
): Promise<string> {
  "use step";

  const content = await ensurePreviously(currentSliceId);
  console.log(`[Previously] Seeded previously.md for ${currentSliceId}`);
  return content;
}

// ─── Step 3: Finalize turn ───────────────────────────────────────────────

/**
 * Persist the agent turn to the episodic slice (the old streamText onFinish),
 * write back pointers for any loops the agent started this turn, and close the
 * run's output stream with the trailing lifecycle chunks.
 *
 * The agent streamed with `sendFinish: false` + `preventClose: true`, so this
 * step owns the stream tail — finish-step / finish, then close. Retries are
 * safe: the slice arrives by value, so re-running appends to the same base
 * copy and the snapshot write is idempotent.
 */
export async function finalizeTurn(
  slice: TimeSlice,
  outcome: TurnOutcome,
  turnId: string,
): Promise<void> {
  "use step";

  // 1. Episodic persistence (the old onFinish branches).
  if (outcome.finishReason === "stop") {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "agent",
      content: outcome.text,
      turnId,
    });
  } else if (outcome.text) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "agent",
      content: `[partial] ${outcome.text}`,
      turnId,
    });
    console.log(`[Episodic] Pro interrupted (${outcome.finishReason})`);
  } else {
    console.log(`[Episodic] Pro produced no text (${outcome.finishReason})`);
  }

  // 2. startLoop writeback: record the slice→loop pointer and weave loop tags
  // into strands (moved here from the old inline tool closure — the executor
  // only knows the sliceId; this step owns the slice by value).
  for (const started of outcome.startedLoops) {
    if (!slice.loops.includes(started.loopId)) {
      slice.loops.push(started.loopId);
    }
    for (const tag of started.tags) {
      if (!slice.tags.includes(tag)) {
        slice.tags.push(tag);
      }
    }
  }

  if (
    outcome.finishReason === "stop" ||
    outcome.text ||
    outcome.startedLoops.length > 0
  ) {
    await saveSliceSnapshot(slice);
    if (outcome.finishReason === "stop") {
      await ensureIndexEntries(slice);
      await generateGlobalTimeline();
    }
  }

  // 2b. Write agent timeline — mechanical extraction from the model's own
  // reasoning traces and tool calls. The cognition body is produced by
  // extractCognition() in the workflow body; here we prepend the header
  // (timestamp stamped in this step, where Date is allowed) and persist.
  if (outcome.cognition) {
    const header = `## Cognition ${turnId} — ${new Date().toISOString()}\n`;
    await writeAgentTimeline(slice.slice_id, header + outcome.cognition);
  }

  // 3. Close the UI stream.
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({ type: "finish-step" } as UIMessageChunk);
  await writer.write({ type: "finish" } as UIMessageChunk);
  writer.releaseLock();
  await writable.close();
}
