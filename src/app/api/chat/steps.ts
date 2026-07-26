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
 *   3. updatePreviously — Flash reviews user + agent cognition → previously.md
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
  generateGlobalTimeline,
  type TimeSlice,
} from "@/lib/episodic";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import {
  applyMetadataUpdates,
  applyBeliefUpdates,
  type BeliefUpdate,
} from "@/lib/episodic/maintenance";
import { runMetadataUpdate } from "@/lib/episodic/flash/metadata";
import { runUpdatePreviously } from "@/lib/episodic/flash/update-previously";
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

  const mw0 = getWritable<UIMessageChunk>().getWriter();
  await mw0.write({
    type: "data-phase" as `data-${string}`,
    id: "phase-metadata",
    data: { phase: "scanning", running: true },
  } as UIMessageChunk);
  mw0.releaseLock();

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

    // Emit phase completion with result data for expandable UI.
    const metaWriter = getWritable<UIMessageChunk>().getWriter();
    await metaWriter.write({
      type: "data-phase" as `data-${string}`,
      id: "phase-metadata",
      data: {
        phase: "scanning",
        running: false,
        summaries: result.needs_metadata_update
          ? [`元数据已更新：${result.reasoning}`]
          : [],
      },
    } as UIMessageChunk);
    metaWriter.releaseLock();

    return { slice, metadataUpdated: result.needs_metadata_update, reasoning: result.reasoning };
  } catch (err) {
    console.warn(
      "[Metadata] Flash call failed, continuing without update:",
      err instanceof Error ? err.message : err
    );

    const metaWriter = getWritable<UIMessageChunk>().getWriter();
    await metaWriter.write({
      type: "data-phase" as `data-${string}`,
      id: "phase-metadata",
      data: {
        phase: "scanning",
        running: false,
        summaries: [],
      },
    } as UIMessageChunk);
    metaWriter.releaseLock();

    return { slice, metadataUpdated: false, reasoning: "Flash unavailable" };
  }
}

// ─── Step 3: Update previously.md (Pro) ────────────────────────────────────

/**
 * Flash reviews BOTH the user conversation AND the agent's own cognition in
 * one call, producing mutations across all three sections of previously.md:
 *
 *   1. User identity    — who the user is (from conversation)
 *   2. User patterns    — how the user works (from conversation)
 *   3. Agent strategies — how to work with this user (from agent cognition)
 *
 * Mode is determined by whether a slice just closed:
 *   normal — every turn, reviews last cognition entry
 *   deep   — on slice close, reviews full closed slice's agent.md
 *
 * Also loads the user profile for system prompt assembly.
 * Never throws — on failure, returns unchanged content and empty updates.
 */
export async function updatePreviously(
  input: TurnInput,
  slice: TimeSlice,
  closedSlice: TimeSlice | undefined,
): Promise<BeliefUpdateResult> {
  "use step";

  const bw0 = getWritable<UIMessageChunk>().getWriter();
  await bw0.write({
    type: "data-phase" as `data-${string}`,
    id: "phase-belief",
    data: { phase: "updatingPreviously", running: true },
  } as UIMessageChunk);
  bw0.releaseLock();

  const isDeep = closedSlice !== undefined;
  const { recentTurns, lastUserMessage } = input;

  const userProfile = await loadUserProfile();
  let allBeliefUpdates: BeliefUpdate[] = [];
  let allReasoning = "";

  // ── Phase 1: Deep review (slice just closed) ──────────────────────────
  // Enrich the CLOSING slice's previously.md before it gets copied forward.
  // This way the closed slice carries its own strategies, and the new slice
  // inherits them through ensurePreviously.
  if (isDeep && closedSlice) {
    let closedAgentCognition = "";
    let closedPreviously = "";

    try {
      closedAgentCognition = await readAgentTimeline(closedSlice.slice_id);
    } catch { /* no agent.md */ }
    try {
      closedPreviously = await readPreviously(closedSlice.slice_id);
    } catch { /* no previously.md */ }

    try {
      const deepResult = await runUpdatePreviously({
        recentTurns,
        newMessage: lastUserMessage,
        previouslyContent: closedPreviously,
        sliceId: closedSlice.slice_id,
        lastTurnId: input.turnId,
        agentCognition: closedAgentCognition,
        isDeep: true,
      });

      if (deepResult.belief_updates.length > 0) {
        const enriched = applyBeliefUpdates(
          closedPreviously,
          deepResult.belief_updates,
          closedSlice.slice_id,
        );
        await writePreviously(closedSlice.slice_id, enriched);

        console.log(
          `[Previously] deep review of ${closedSlice.slice_id}: ` +
          `${deepResult.belief_updates.length} mutations ` +
          `sections=${deepResult.belief_updates.map(u => u.section).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`
        );

        // Collect deep review updates for the UI chunk.
        allBeliefUpdates.push(...deepResult.belief_updates);
        allReasoning = deepResult.reasoning;
      }
    } catch (err) {
      console.warn(
        "[Previously] Deep review failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Phase 2: Seed the new slice's previously.md ───────────────────────
  // Now that the closing slice's previously.md is enriched, copy it forward.
  // ensurePreviously scans backward and copies from the most recent slice
  // (which is the one we just enriched above).
  await ensurePreviously(slice.slice_id);

  // ── Phase 3: Normal review (current slice, every turn) ────────────────
  let previouslyContent = "";
  try {
    previouslyContent = await readPreviously(slice.slice_id);
  } catch { /* use empty */ }

  let agentCognition = "";
  try {
    agentCognition = await readAgentTimeline(slice.slice_id);
  } catch { /* no agent.md yet */ }

  try {
    const normalResult = await runUpdatePreviously({
      recentTurns,
      newMessage: lastUserMessage,
      previouslyContent,
      sliceId: slice.slice_id,
      lastTurnId: input.turnId,
      agentCognition,
      isDeep: false,
    });

    if (normalResult.belief_updates.length > 0) {
      console.log(
        `[Previously] normal review: ${normalResult.belief_updates.length} mutations ` +
        `sections=${normalResult.belief_updates.map(u => u.section).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`
      );

      const updated = applyBeliefUpdates(
        previouslyContent,
        normalResult.belief_updates,
        slice.slice_id,
      );
      await writePreviously(slice.slice_id, updated);
      previouslyContent = updated;

      allBeliefUpdates.push(...normalResult.belief_updates);
      if (!allReasoning) allReasoning = normalResult.reasoning;
    }
  } catch (err) {
    console.warn(
      "[Previously] Normal review failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── Emit UI chunk ─────────────────────────────────────────────────────
  if (allBeliefUpdates.length > 0) {
    try {
      const summaries = allBeliefUpdates.map((u) => {
        switch (u.action) {
          case "observe":
            return u.section === "Agent strategies"
              ? `+ 优化了工作方式：${u.belief ?? u.belief_key ?? ""}`
              : `+ 注意到：${u.belief ?? u.belief_key ?? "新印象"}`;
          case "reinforce":
            return u.section === "Agent strategies"
              ? `↑ 策略确认：${u.belief_key ?? ""}`
              : `↑ 加深了印象：${u.belief_key ?? ""}`;
          case "contradict":
            return `↓ 调整了判断：${u.belief_key ?? ""}${u.note ? ` — ${u.note}` : ""}`;
          case "discard":
            return `✕ 移除了过时的内容：${u.belief_key ?? u.reason ?? ""}`;
          default:
            return "";
        }
      }).filter(Boolean);

      const writer = getWritable<UIMessageChunk>().getWriter();
      // Phase completion carries summaries so the UI can expand to show details.
      await writer.write({
        type: "data-phase" as `data-${string}`,
        id: "phase-belief",
        data: {
          phase: "updatingPreviously",
          running: false,
          mode: isDeep ? "deep" : "normal",
          summaries,
          previouslyContent: previouslyContent.slice(0, 5000),
        },
      } as UIMessageChunk);
      writer.releaseLock();
    } catch (err) {
      console.warn("[Previously] UI chunk failed:", err instanceof Error ? err.message : err);
    }
  } else {
    // Always emit a phase indicator so the UI shows progress even when
    // there are no belief changes this turn.
    try {
      const pw = getWritable<UIMessageChunk>().getWriter();
      await pw.write({
        type: "data-phase" as `data-${string}`,
        id: "phase-belief",
        data: {
          phase: "updatingPreviously",
          running: false,
          summaries: [],
        },
      } as UIMessageChunk);
      pw.releaseLock();
    } catch (err) {
      // non-critical — progress indicator only
    }
  }

  return {
    slice,
    previouslyContent,
    beliefUpdates: allBeliefUpdates,
    userProfile: buildAgentIdentityPrompt(userProfile),
    reasoning: allReasoning,
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
