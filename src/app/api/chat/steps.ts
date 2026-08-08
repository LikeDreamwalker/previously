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
  analyzeTurn,
  findMatchingStrand,
  getStrandsPath,
  serializeStrands,
  type TimeSlice,
  type StrandIndex,
  type SlicingSignal,
} from "@/lib/episodic";
import { consolidateStrands } from "@/lib/episodic/flash/strand-consolidator";
import { checkTimeSilence } from "@/lib/episodic/slicer";
import { fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import {
  buildAgentIdentityPrompt,
  parseIdentityFromPreviously,
} from "@/lib/identity";
import {
  classifyContinuity,
  buildTurnPriming,
  type PrevSliceRef,
} from "@/lib/turn-priming";
import type {
  TurnInput,
  HousekeepingResult,
  TurnOutcome,
} from "@/lib/chat/turn-types";
import { deriveTurnStatus } from "@/lib/chat/turn-types";


// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Emit a compact housekeeping phase (rendered as a ToolLayout card on the
 * client). Each phase is a `data-phase` chunk with `compact: true` so
 * buildStream renders it as an unobtrusive tool-style bar, not a prominent
 * PhaseIndicator. Emit `running: true` before the work, `running: false`
 * (with result summaries) after.
 */
async function emitPhase(
  phase: string,
  running: boolean,
  summaries?: string[],
): Promise<void> {
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({
    type: "data-phase" as `data-${string}`,
    id: `phase-${phase}`,
    data: { phase, running, compact: true, summaries },
  } as UIMessageChunk);
  writer.releaseLock();
}

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
 * Format a compact menu from an already-loaded strand index for the system
 * prompt. Tags only, sorted by most recently active slice, max 20.
 * Returns empty string if no strands exist.
 */
function buildStrandsMenu(strands: StrandIndex): string {
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

/** Slice → continuity reference (end time comes from closeSlice's mutation). */
function toPrevRef(s: TimeSlice): PrevSliceRef {
  return { id: s.slice_id, focus: s.focus, start: s.start, end: s.end };
}

/**
 * Find the most recent closed slice from the global timeline (newest first) —
 * used for continuity when today has no active slice (cross-day return).
 * Returns null if the timeline is unavailable.
 */
async function readMostRecentClosedSlice(): Promise<PrevSliceRef | null> {
  try {
    const raw = await fsReadFile("memory/episodic/timeline.md");
    const m = raw.match(/^## (.+)\n- Focus: (.*)\n[\s\S]*?- Start: ([^\n]+)/m);
    if (!m) return null;
    return { id: m[1].trim(), focus: m[2].trim(), start: m[3].trim() };
  } catch {
    return null;
  }
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

  // ── Phase: slice — manage the time slice (recover/close/create) ─────
  await emitPhase("slice", true);

  const { config, clientTimezone, lastUserMessage, modelMessages } = input;
  const silenceMs = config.slicing.timeSilenceMinutes * 60 * 1000;

  // ── Begin batch: all writes below go into ONE git commit ──────────────
  startBatch();

  let slice: TimeSlice;
  /** The slice we came from — set when we close one this call, or resolved
   *  from the global timeline when today has none. Drives the continuity brief. */
  let prevSlice: PrevSliceRef | null = null;
  const diskSlice = await tryLoadTodaySlice();

  // ── 1. Decide lifecycle (pure — no I/O, no LLM yet) ──────────────────
  let closeSignal: SlicingSignal | null = null;
  if (diskSlice && diskSlice.status === "active") {
    const lastTurn = diskSlice.turns[diskSlice.turns.length - 1];
    const lastActivity = lastTurn
      ? new Date(lastTurn.timestamp).getTime()
      : Date.now();

    if (checkTimeSilence(lastActivity, silenceMs)) {
      closeSignal = "time_silence";
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      closeSignal = "capacity";
    } else if (checkContextLost(modelMessages, diskSlice)) {
      closeSignal = "context_lost";
    }
  }

  // ── 2. One worker-model analyze: message tags + semantic hint + (on close) marking ──
  // Phase: tags — one cheap worker-model pass extracts topics from the message.
  await emitPhase("tags", true);
  const existingStrands = await readStrands();
  const analysis = await analyzeTurn({
    model: input.workerModel,
    userMessage: lastUserMessage,
    existingStrandNames: Object.keys(existingStrands),
    closingSlice:
      closeSignal && diskSlice
        ? { turns: diskSlice.turns, tags: diskSlice.tags }
        : undefined,
  });

  // ── 3. Execute lifecycle — close marking is applied BEFORE the slice persists ──
  if (closeSignal && diskSlice) {
    if (analysis.closedMarking) {
      if (analysis.closedMarking.focus) diskSlice.focus = analysis.closedMarking.focus;
      if (analysis.closedMarking.summary) diskSlice.summary = analysis.closedMarking.summary;
      if (analysis.closedMarking.tags.length > 0) diskSlice.tags = analysis.closedMarking.tags;
      if (analysis.closedMarking.tone) diskSlice.emotional_tone = analysis.closedMarking.tone;
    }
    prevSlice = toPrevRef(diskSlice);
    await closeSlice(diskSlice, closeSignal);
    console.log(`[Episodic] Closed slice: ${diskSlice.slice_id} (${closeSignal})`);
    await generateGlobalTimeline();

    // Strand consolidation (opportunistic, on slice close): prune single-use
    // stale strands deterministically; when the index is large enough, ask the
    // worker model for a from→to merge map to collapse semantic duplicates
    // (typos / same-concept-two-names) that deterministic normalization can't
    // catch. Writes land in the current batch → one commit with the close.
    const strandsBefore = await readStrands();
    const { strands: consolidated, pruned, merges, llmPassSkipped } =
      await consolidateStrands(strandsBefore, input.workerModel);
    if (pruned.length > 0 || merges.length > 0) {
      await fsWriteFile(getStrandsPath(), serializeStrands(consolidated));
      console.log(
        `[Strands] Consolidation: pruned ${pruned.length}, merged ${merges.length}` +
        (llmPassSkipped ? " (llm skipped)" : ""),
      );
    }

    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
  } else if (diskSlice && diskSlice.status === "active") {
    slice = diskSlice;
    console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
  }

  // ── 4. Apply the current message's tags to the active slice ──────────
  // Merge-first at the slice boundary too: `reuse` tags must resolve to an
  // existing strand (a hallucinated name is dropped, never minted); `create`
  // tags are folded into an existing strand via normalized-match before a new
  // key is ever allowed. This keeps a slice's accumulated tags from inventing
  // near-duplicate strands mid-slice (they'd otherwise hit strands.json before
  // the close-time cleaning replaces them).
  const appliedTags: string[] = [];
  // Semantic gate: trivial turns (greetings, "继续", thanks, small talk) carry
  // no durable info — skip tag extraction and strand weaving entirely, so
  // strands.json stays clean instead of accruing one-off noise.
  if (analysis.memoryWorthy) {
    for (const tag of analysis.messageTags.reuse) {
      const target = findMatchingStrand(existingStrands, tag);
      if (!target) continue; // not an existing topic — don't mint from a reuse slot
      if (!slice.tags.includes(target)) {
        slice.tags.push(target);
        appliedTags.push(target);
      }
    }
    for (const { tag } of analysis.messageTags.create) {
      const target = findMatchingStrand(existingStrands, tag) ?? tag;
      if (!slice.tags.includes(target)) {
        slice.tags.push(target);
        appliedTags.push(target);
      }
    }
  }
  if (appliedTags.length > 0) {
    console.log(`[FlashTags] Applied: ${appliedTags.join(", ")}`);
  }
  await emitPhase("tags", false, appliedTags);

  // ── 5. Append user turn ───────────────────────────────────────────────
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
  await emitPhase("slice", false, [slice.slice_id]);

  // ── Phase: context — load the user profile (previously + identity) ───
  await emitPhase("context", true);

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

  // ── Phase: strands — weave the memory-topic index ────────────────────
  await emitPhase("strands", true);
  const strands = await readStrands();
  const strandsMenu = buildStrandsMenu(strands);
  await emitPhase("strands", false, [`${Object.keys(strands).length} strands`]);

  // ── 6b. Continuity + turn priming + identity ─────────────────────────
  // Continuity source: a slice we closed this call (its `end` is exact), else
  // the most recent closed slice from the global timeline (cross-day return).
  // Skipped entirely when we're continuing the same active slice.
  if (!prevSlice && slice !== diskSlice) {
    prevSlice = await readMostRecentClosedSlice();
  }
  const continuity = classifyContinuity(
    input.startedAtIso,
    prevSlice,
    slice === diskSlice,
  );

  const turnPriming = buildTurnPriming({
    message: input.lastUserMessage,
    clientTimezone: input.clientTimezone,
    nowIso: input.startedAtIso,
    continuity,
    strands,
    excludeSliceId: slice.slice_id,
    semanticHint: analysis.semanticHint,
    intent: analysis.intent,
  });

  // The agent's constitution (SOUL + who-you're-assisting + DIRECTIVES),
  // derived from the already-loaded previously.md identity section.
  const profile = parseIdentityFromPreviously(previouslyContent);
  const identityPrompt = buildAgentIdentityPrompt(profile);

  await emitPhase("context", false, [`continuity: ${continuity.tier}`]);

  // ── 7. Open UI stream ────────────────────────────────────────────────
  const writer = getWritable<UIMessageChunk>().getWriter();
  await writer.write({ type: "start" } as UIMessageChunk);
  await writer.write({ type: "start-step" } as UIMessageChunk);
  writer.releaseLock();

  return { slice, previouslyContent, strandsMenu, turnPriming, identityPrompt };
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

  // 1. Episodic persistence (the old onFinish branches). `outcome.text` is the
  // agent's FULL assistant text for the turn (intermediate + final), so the
  // stored slice keeps both ends; tool calls are not preserved.
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

  // 3. Close the UI stream. Emit the terminal turn-status chunk just before
  // the lifecycle tail so the client learns the outcome from the live stream.
  // A reconnecting client replays the stream from the last-seen index and
  // derives the status from the final assistant message.
  const status = deriveTurnStatus(outcome);
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({
    type: "data-turn-status",
    id: "turn-status-terminal",
    data: {
      status,
      turnId,
      updatedAt: new Date().toISOString(),
      // Client-visible explanation for terminal/model failures — lets the UI
      // say WHY the turn ended instead of failing silently.
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  } as UIMessageChunk);
  await writer.write({ type: "finish-step" } as UIMessageChunk);
  await writer.write({ type: "finish" } as UIMessageChunk);
  writer.releaseLock();
  await writable.close();
}
