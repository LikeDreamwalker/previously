/**
 * Chat turn step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (gray-matter + fs, the episodic manager, DeepSeek Flash) never enter the
 * deterministic workflow sandbox. `turn-workflow.ts` imports these
 * `"use step"` functions by reference only; the loader compiles them into the
 * step bundle, not the workflow bundle.
 *
 * Steps:
 *   1. housekeeping     — recover/close/create slice, append user turn, open UI stream
 *   2. metadataUpdate   — Flash reviews slice metadata (focus/summary/tags/tone)
 *   3. beliefUpdate     — Flash observes user patterns → previously.md updates
 *   4. finalizeTurn     — persist agent turn, close UI stream
 *
 * Chunk order for the UI: data-belief → reasoning/text/tool → done.
 */
import { type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import { buildAgentIdentityPrompt, loadUserProfile } from "@/lib/identity";
import {
  createSlice,
  closeSlice,
  appendTurn,
  saveSliceSnapshot,
  ensureIndexEntries,
  tryLoadTodaySlice,
  writeAgentTimeline,
  readAgentTimeline,
  readPreviously,
  writePreviously,
  ensurePreviously,
  type TimeSlice,
} from "@/lib/episodic";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import {
  applyMetadataUpdates,
  applyBeliefUpdates,
  type BeliefUpdate,
} from "@/lib/episodic/maintenance";
import { runMetadataUpdate } from "@/lib/episodic/flash/metadata";
import { runBeliefUpdate } from "@/lib/episodic/flash/belief";
import type {
  TurnInput,
  HousekeepingResult,
  MetadataUpdateResult,
  BeliefUpdateResult,
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
      closedSlice = diskSlice;
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      // Force-close on turn count (safety net for marathon sessions).
      await closeSlice(diskSlice, "capacity");
      console.log(`[Episodic] Closed at turn cap: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
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

  // Ensure previously.md exists for this slice (initialize with decay from
  // last frozen, or create empty template for first-ever slices).
  await ensurePreviously(slice.slice_id);

  // Durable snapshot BEFORE streaming (was fire-and-forget in the inline route):
  // guarantees the user turn is on GitHub, and that the next turn's
  // tryLoadTodaySlice sees it even if the agent never finishes.
  await saveSliceSnapshot(slice);
  await ensureIndexEntries(slice);

  // Open the UI message stream. Lifecycle chunks are written INTO the durable
  // run stream (not injected by the route transform) so the POST path and the
  // reconnect path replay identical chunk sequences — WorkflowChatTransport
  // resumes by chunk index, which must line up across both.
  const writer = getWritable<UIMessageChunk>().getWriter();
  await writer.write({ type: "start" } as UIMessageChunk);
  await writer.write({ type: "start-step" } as UIMessageChunk);
  writer.releaseLock();

  return { slice, closedSlice };
}

// ─── Step 2: Metadata update (Flash) ───────────────────────────────────────

/**
 * Flash reviews the current slice metadata (focus, summary, decisions, open
 * loops, tags, emotional tone) against recent conversation and updates stale
 * fields. Pure maintenance — no recall, no beliefs, no intent.
 * Never throws — Flash is fallible, so failure yields unchanged slice.
 */
export async function metadataUpdate(
  input: TurnInput,
  slice: TimeSlice
): Promise<MetadataUpdateResult> {
  "use step";

  const { recentTurns, lastUserMessage } = input;

  try {
    const result = await runMetadataUpdate({
      slice: {
        slice_id: slice.slice_id,
        focus: slice.focus || "",
        summary: slice.summary || "",
        open_loops: slice.open_loops || [],
        decisions: slice.decisions || [],
        tags: slice.tags || [],
        emotional_tone: slice.emotional_tone || "neutral",
      },
      recentTurns,
      newMessage: lastUserMessage,
    });

    console.log(
      `[Metadata] updated=${result.needs_metadata_update} reasoning=${result.reasoning.slice(0, 80)}`
    );

    if (result.needs_metadata_update && result.metadata_updates) {
      const meta = {
        slice_id: slice.slice_id,
        focus: slice.focus || "",
        summary: slice.summary || "",
        open_loops: slice.open_loops || [],
        decisions: slice.decisions || [],
        tags: slice.tags || [],
        emotional_tone: slice.emotional_tone || "neutral",
      };
      applyMetadataUpdates(meta, result.metadata_updates);
      slice.focus = meta.focus;
      slice.summary = meta.summary;
      slice.open_loops = meta.open_loops;
      slice.decisions = meta.decisions;
      slice.tags = meta.tags;
      slice.emotional_tone = meta.emotional_tone as typeof slice.emotional_tone;
    }

    return { slice, metadataUpdated: result.needs_metadata_update, reasoning: result.reasoning };
  } catch (err) {
    console.warn(
      "[Metadata] Flash call failed, continuing without update:",
      err instanceof Error ? err.message : err
    );
    return { slice, metadataUpdated: false, reasoning: "Flash unavailable" };
  }
}

// ─── Step 3: Belief update (Flash) ─────────────────────────────────────────

/**
 * Flash observes the current conversation against the existing belief system
 * (previously.md) and produces belief mutations (observe/reinforce/contradict/
 * discard). Updates previously.md in-place and emits a `data-belief` UI chunk.
 * Also loads the user profile for system prompt assembly in the workflow body.
 * Never throws — on failure, returns unchanged previously.md and empty updates.
 */
export async function beliefUpdate(
  input: TurnInput,
  slice: TimeSlice
): Promise<BeliefUpdateResult> {
  "use step";

  const { recentTurns, lastUserMessage } = input;

  // Load profile, previously.md, and recent agent cognition
  const userProfile = await loadUserProfile();
  let previouslyContent = "";
  let agentCognition = "";
  try {
    agentCognition = await readAgentTimeline(slice.slice_id);
  } catch {
    // No agent.md yet — first turn in slice
  }
  try {
    previouslyContent = await readPreviously(slice.slice_id);
  } catch {
    // No previously.md yet — use empty template
  }

  let beliefUpdates: BeliefUpdate[] = [];
  let reasoning = "";

  try {
    const result = await runBeliefUpdate({
      recentTurns,
      newMessage: lastUserMessage,
      previouslyContent,
      sliceId: slice.slice_id,
      agentCognition,
    });

    beliefUpdates = result.belief_updates;
    reasoning = result.reasoning;

    console.log(
      `[Belief] updates=${beliefUpdates.length} actions=${beliefUpdates.map(u => u.action).join(", ") || "none"}`
    );

    if (beliefUpdates.length > 0) {
      const updated = applyBeliefUpdates(
        previouslyContent,
        beliefUpdates,
        slice.slice_id,
      );
      await writePreviously(slice.slice_id, updated);
      previouslyContent = updated;
    }
  } catch (err) {
    console.warn(
      "[Belief] Flash call failed, continuing without belief update:",
      err instanceof Error ? err.message : err
    );
  }

  // Emit data-belief UI chunk for self-evolution visibility
  if (beliefUpdates.length > 0) {
    try {
      const summaries = beliefUpdates.map((u) => {
        switch (u.action) {
          case "observe":
            return `+ 注意到：${u.belief ?? u.belief_key ?? "新印象"}`;
          case "reinforce":
            return `↑ 加深了印象：${u.belief_key ?? ""}`;
          case "contradict":
            return `↓ 调整了判断：${u.belief_key ?? ""}${u.note ? ` — ${u.note}` : ""}`;
          case "discard":
            return `✕ 移除了过时的印象：${u.belief_key ?? u.reason ?? ""}`;
          default:
            return "";
        }
      }).filter(Boolean);

      const writer = getWritable<UIMessageChunk>().getWriter();
      await writer.write({
        type: "data-belief",
        id: `belief-${Date.now()}`,
        data: {
          phase: "belief",
          done: true,
          updates: beliefUpdates,
          summaries,
        },
      } as UIMessageChunk);
      writer.releaseLock();
    } catch (err) {
      console.warn("[Belief] UI chunk failed:", err instanceof Error ? err.message : err);
    }
  }

  return {
    slice,
    previouslyContent,
    beliefUpdates,
    userProfile: buildAgentIdentityPrompt(userProfile),
    reasoning,
  };
}

// ─── Step 4: Finalize turn ───────────────────────────────────────────────

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
