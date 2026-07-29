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
 *   1. housekeeping  — recover/close/create slice, context continuity check,
 *      Flash tag extraction, ensure previously.md, strands menu, open UI stream
 *   2. finalizeTurn  — persist agent turn, close UI stream
 *
 * Chunk order for the UI: start → start-step → data-phase(slicing) → finish-step → finish.
 */
import { type UIMessageChunk, type ModelMessage } from "ai";
import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
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
  readStrands,
  generateGlobalTimeline,
  startBatch,
  flushBatch,
  type TimeSlice,
} from "@/lib/episodic";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import type {
  TurnInput,
  HousekeepingResult,
  TurnOutcome,
} from "@/lib/chat/turn-types";


// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Detect when the client has lost conversational context (page refresh,
 * device switch). Compares assistant messages in the client's message
 * history against agent turns in the recovered slice.
 */
function checkContextLost(modelMessages: ModelMessage[], slice: TimeSlice): boolean {
  const assistantCount = modelMessages.filter(
    (m) => m.role === "assistant"
  ).length;
  const agentTurnCount = slice.turns.filter(
    (t) => t.role === "agent"
  ).length;

  // Client has 0 assistant messages but slice has agent turns → context lost
  if (assistantCount === 0 && agentTurnCount >= 1) return true;
  // Client barely remembers (1 assistant) but slice has many turns → context lost
  if (assistantCount <= 1 && agentTurnCount >= 3) return true;

  return false;
}

/**
 * Call Flash (thinking disabled) to extract keyword tags from a user message.
 * Existing strand names are provided to encourage reuse and semantic merging.
 * Returns 0-5 lowercase tags. Never throws — returns [] on any failure.
 */
async function extractFlashTags(
  userMessage: string,
  existingTagNames: string[],
): Promise<string[]> {
  const tagsList = existingTagNames.length > 0
    ? `Existing tags (reuse when semantically equivalent): ${existingTagNames.join(", ")}`
    : "No existing tags yet.";

  const prompt = `Extract 0-5 keyword tags from this user message.

${tagsList}

Rules:
- Lowercase, 1-3 words per tag
- Same concept in any language → REUSE the existing tag (e.g. if user says "Rust" in a Chinese context, reuse "rust")
- Only substantive topic tags (not greetings or filler)
- Return empty array if nothing worth tagging

User: ${userMessage.slice(0, 500)}`;

  try {
    const result = await generateText({
      model: deepseek("deepseek-v4-flash"),
      prompt,
      temperature: 0.1,
      tools: {
        tagOutput: tool({
          description: "Report extracted tags.",
          inputSchema: z.object({
            tags: z.array(z.string()).max(5).describe("0-5 keyword tags."),
          }),
        }),
      },
      toolChoice: "required",
      providerOptions: { deepseek: { thinking: { type: "disabled" as const } } },
    });

    const tc = result.toolCalls?.[0];
    if (tc?.toolName === "tagOutput") {
      const input = tc.input as { tags?: string[] };
      return (input.tags ?? []).slice(0, 5);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Read strands.json and format a compact menu for the system prompt.
 * Tags only, sorted by most recently active slice, max 20.
 * Returns empty string if no strands exist.
 */
async function buildStrandsMenu(): Promise<string> {
  const strands = await readStrands();
  const entries = Object.entries(strands);

  if (entries.length === 0) return "";

  // Sort by most recent slice associated with each strand
  entries.sort((a, b) => {
    const aMax = a[1].reduce((max, p) => (p > max ? p : max), "");
    const bMax = b[1].reduce((max, p) => (p > max ? p : max), "");
    return bMax.localeCompare(aMax);
  });

  const tagNames = entries.slice(0, 20).map(([name]) => name);
  return `Known topics: ${tagNames.join(", ")}`;
}

// ─── Step 1: Housekeeping ────────────────────────────────────────────────

/**
 * Recover today's slice from GitHub truth (never the module global — it does
 * not survive across workflow invocations), close it on time-silence / turn
 * cap, or create a fresh one. Append the user turn and durably snapshot before
 * returning, so the message is on GitHub before we stream anything.
 */
export async function housekeeping(input: TurnInput): Promise<HousekeepingResult> {
  "use step";

  // ── Phase: UI spinner ──────────────────────────────────────────────────
  const phaseWriter0 = getWritable<UIMessageChunk>().getWriter();
  await phaseWriter0.write({
    type: "data-phase" as `data-${string}`,
    id: "phase-prepare",
    data: { phase: "slicing", running: true },
  } as UIMessageChunk);
  phaseWriter0.releaseLock();

  const { config, clientTimezone, lastUserMessage, modelMessages } = input;
  const silenceMs = config.slicing.timeSilenceMinutes * 60 * 1000;

  // ── Begin batch: all writes below go into ONE git commit ──────────────
  startBatch();

  let slice: TimeSlice;
  const diskSlice = await tryLoadTodaySlice();

  // ── 1. Slice lifecycle + context continuity ──────────────────────────
  if (diskSlice && diskSlice.status === "active") {
    const lastTurn = diskSlice.turns[diskSlice.turns.length - 1];
    const lastActivity = lastTurn
      ? new Date(lastTurn.timestamp).getTime()
      : Date.now();

    if (checkTimeSilence(lastActivity, silenceMs)) {
      await closeSlice(diskSlice, "time_silence");
      console.log(`[Episodic] Closed stale slice: ${diskSlice.slice_id}`);
      await generateGlobalTimeline();
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      await closeSlice(diskSlice, "capacity");
      console.log(`[Episodic] Closed at turn cap: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
      await generateGlobalTimeline();
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else if (checkContextLost(modelMessages, diskSlice)) {
      await closeSlice(diskSlice, "context_lost");
      console.log(`[Episodic] Closed (context lost): ${diskSlice.slice_id} (client has ${modelMessages.filter(m => m.role === "assistant").length} assistant msgs, slice has ${diskSlice.turns.filter(t => t.role === "agent").length} agent turns)`);
      await generateGlobalTimeline();
      slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    } else {
      slice = diskSlice;
      console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
    }
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
  }

  // ── 2. Append user turn ───────────────────────────────────────────────
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

  // ── 3. Flash tag extraction ──────────────────────────────────────────
  try {
    const strands = await readStrands();
    const existingTagNames = Object.keys(strands);
    const newTags = await extractFlashTags(lastUserMessage, existingTagNames);

    if (newTags.length > 0) {
      for (const tag of newTags) {
        if (!slice.tags.includes(tag)) {
          slice.tags.push(tag);
        }
      }
      console.log(`[FlashTags] Extracted: ${newTags.join(", ")}`);
    }
  } catch (err) {
    console.warn("[FlashTags] Extraction failed:", err instanceof Error ? err.message : err);
  }

  // ── 4. Ensure previously.md (pure copy forward, no decay) ────────────
  const previouslyContent = await ensurePreviously(slice.slice_id);
  console.log(`[Previously] Seeded previously.md for ${slice.slice_id}`);

  // ── 5. Durable snapshot + index/strand maintenance ───────────────────
  await saveSliceSnapshot(slice);
  await ensureIndexEntries(slice);
  await generateGlobalTimeline();

  // Commit all queued writes as one commit before building the menu
  // (which reads strands.json) and opening the UI stream.
  await flushBatch(`Turn ${input.turnId} — housekeeping`);

  // ── 6. Build strands menu ────────────────────────────────────────────
  const strandsMenu = await buildStrandsMenu();

  // ── 7. Open UI stream ────────────────────────────────────────────────
  const writer = getWritable<UIMessageChunk>().getWriter();
  await writer.write({ type: "start" } as UIMessageChunk);
  await writer.write({ type: "start-step" } as UIMessageChunk);
  await writer.write({
    type: "data-phase" as `data-${string}`,
    id: "phase-prepare",
    data: { phase: "slicing", running: false },
  } as UIMessageChunk);
  writer.releaseLock();

  return { slice, previouslyContent, strandsMenu };
}

// ─── Step 2: Finalize turn ───────────────────────────────────────────────

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

  // ── Begin batch: all writes below go into ONE git commit ──────────────
  startBatch();

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

  // Commit all queued writes as one commit before closing the stream.
  await flushBatch(`Turn ${turnId} — agent response`);

  // 3. Close the UI stream.
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({ type: "finish-step" } as UIMessageChunk);
  await writer.write({ type: "finish" } as UIMessageChunk);
  writer.releaseLock();
  await writable.close();
}
