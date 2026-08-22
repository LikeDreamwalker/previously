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
  weaveTimeline,
  buildTimelineBrief,
  readTimelineIndex,
  upsertTimelineEntry,
  deterministicSliceMark,
  createBatch,
  flushBatch,
  analyzeTurn,
  shouldRunCardEvolution,
  readCurrentPreviously,
  findMatchingStrand,
  getStrandsPath,
  serializeStrands,
  sliceIdToFilePath,
  type TimeSlice,
  type StrandIndex,
  type SlicingSignal,
  type WriteBatch,
} from "@/lib/episodic";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { mergeTurnsWithRemote } from "@/lib/episodic/turn-merge";
import { isRefConflictError } from "@/lib/tools/batch-write";
import { getRepoConfig } from "@/lib/capabilities";
import { consolidateStrands } from "@/lib/episodic/flash/strand-consolidator";
import { backfillDrySliceMarks } from "@/lib/episodic/flash/backfill-marks";
import { checkSliceAge } from "@/lib/episodic/slicer";
import { fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import {
  buildAgentIdentityPrompt,
  parseIdentityFromPreviously,
} from "@/lib/identity";
import {
  classifyContinuity,
  buildSliceHeadBlock,
  type PrevSliceRef,
} from "@/lib/turn-priming";
import type {
  TurnInput,
  HousekeepingResult,
  TurnOutcome,
  EvolutionResult,
} from "@/lib/chat/turn-types";
import { deriveTurnStatus } from "@/lib/chat/turn-types";
import {
  runCardEvolution,
  type CardEvolutionReaders,
} from "@/app/api/evolution/run-card-evolution";
import { readFile, invalidateReadCache } from "@/lib/tools/readFile";
import { readFileLocal } from "@/lib/tools/local-fs";
import { readFileDemo } from "@/lib/demo/demo-fs";
import { parseSliceId, parseTurns } from "@/lib/episodic/turn-parser";
import { CARD_STAMP } from "@/lib/episodic/previously-format";
import {
  localDateKey,
  normalizeLocale,
  relPhrase,
} from "@/lib/time/relative";
import {
  shouldEmitProgress,
  type ProgressWriteState,
} from "@/lib/chat/progress-throttle";


// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * One step's stream writer — a SINGLE reused `getWritable()` writer behind a
 * serial queue.
 *
 * WHY: the old pattern grabbed a fresh `getWriter()` per chunk. A writer holds
 * the stream lock from acquisition until its `write()` resolves, and a second
 * `getWriter()` on a locked stream THROWS — so a fire-and-forget progress frame
 * whose write was still in flight made the very next emit (e.g. the evolution
 * TERMINAL frame, fired milliseconds later) throw; the catch-all then retried
 * fire-and-forget and could swallow the retry too. The card never received its
 * terminal chunk and spun forever — while later phases (emitted after slow I/O
 * released the lock) landed fine. The sub-agent runner already solved this for
 * `data-tool-progress` with one reused writer ("a fresh pipeline per write
 * failed silently on long runs") — this is the same discipline for the
 * housekeeping/evolution channel.
 *
 * The serial queue preserves chunk order across awaited and fire-and-forget
 * senders; a failed write drops the writer so the next queued chunk re-acquires
 * a fresh one instead of failing forever. `close()` releases the lock at step
 * end so the step's HTTP request can terminate and later steps get a writer.
 */
interface StepStream {
  /** Queue a chunk; resolves once the chunk has actually been written. */
  write(chunk: UIMessageChunk): Promise<void>;
  /** Fire-and-forget queued write (live progress frames). */
  send(chunk: UIMessageChunk): void;
  /** Release the writer lock. ALWAYS call at step end. */
  close(): void;
}

function createStepStream(): StepStream {
  let writer: WritableStreamDefaultWriter<UIMessageChunk> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (chunk: UIMessageChunk): Promise<void> => {
    queue = queue.then(async () => {
      try {
        if (!writer) writer = getWritable<UIMessageChunk>().getWriter();
        await writer.write(chunk);
      } catch {
        // The stream is gone (client disconnect) or the writer broke — drop it
        // so the next queued write re-acquires a fresh one.
        try {
          writer?.releaseLock();
        } catch {
          /* already released */
        }
        writer = null;
      }
    });
    return queue;
  };
  return {
    write: enqueue,
    send(chunk) {
      void enqueue(chunk);
    },
    close() {
      try {
        writer?.releaseLock();
      } catch {
        /* ignore */
      }
      writer = null;
    },
  };
}

/**
 * Emit a compact housekeeping phase (rendered as a ToolLayout card on the
 * client). Each phase is a `data-phase` chunk with `compact: true` so
 * buildStream renders it as an unobtrusive tool-style bar, not a prominent
 * PhaseIndicator. Emit `running: true` before the work, `running: false`
 * (with result summaries) after.
 */
async function emitPhase(
  stream: StepStream,
  phase: string,
  running: boolean,
  summaries?: string[],
): Promise<void> {
  await stream.write({
    type: "data-phase" as `data-${string}`,
    id: `phase-${phase}`,
    data: { phase, running, compact: true, summaries },
  } as UIMessageChunk);
}

/**
 * Emit a data-evolution progress chunk — the evolution card's running frame.
 * All evolution chunks share the id "evolution" so the client merges them into
 * ONE standalone streaming card: `status: "running"` frames carry the phase
 * step and (while the Previously Agent streams) the live thinking/writing
 * line; the terminal frame (emitEvolutionResult) carries `status: "done"`.
 * The legacy `running` key is kept for backward compatibility.
 *
 * Fire-and-forget onto the step stream's serial queue — live frames must not
 * block the agent loop; ordering against the terminal frame is guaranteed by
 * the queue.
 */
function emitEvolutionProgress(
  stream: StepStream,
  step: "reading" | "reviewing",
  live?: string,
  liveStage?: "thinking" | "writing",
): void {
  stream.send({
    type: "data-evolution" as `data-${string}`,
    id: "evolution",
    data: {
      running: true,
      status: "running",
      step,
      ...(live ? { live, liveStage } : {}),
    },
  } as UIMessageChunk);
}

/**
 * Emit the terminal evolution chunk with the change summary. AWAITED — this
 * frame settles the card, so it must actually reach the stream (the serial
 * queue behind `stream.write` is what makes that reliable).
 */
async function emitEvolutionResult(
  stream: StepStream,
  result: EvolutionResult,
): Promise<void> {
  await stream.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution",
    data: {
      running: false,
      status: "done",
      changes: result.changes ?? {
        added: result.changed ? 1 : 0,
        reinforced: 0,
        demoted: result.droppedRecent,
        removed: 0,
        superseded: 0,
      },
      hasChanges: result.changed,
      // The review's reasoning + the actual line diff — the indicator's
      // expanded content. `error` marks a FAILED run (never a legit no-change).
      note: result.note,
      // The agent's one-sentence user-language account — the indicator's
      // headline and the core agent's notice.
      ...(result.summary ? { summary: result.summary } : {}),
      mutations: result.mutations ?? [],
      ...(result.error ? { error: result.error } : {}),
      // A pass cut off without a finish call — the card is partial work.
      ...(result.partial ? { partial: true } : {}),
    },
  } as UIMessageChunk);
}

/**
 * File readers for the inline card evolution — same storage backends the turn
 * uses, so the Previously Agent can explore past slices / cognition / cards.
 */
function buildCardReaders(input: TurnInput): CardEvolutionReaders {
  const readRaw = async (path: string): Promise<string> => {
    if (input.useDemo) return readFileDemo(path);
    if (input.useGithub) return readFile(path, input.repo, input.owner);
    return readFileLocal(path);
  };
  return {
    readSlice: async (sid, range) => {
      const parsed = parseSliceId(sid);
      if (!parsed) return `ERROR: Invalid slice ID.`;
      const raw = await readRaw(
        `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`,
      );
      if (range && range.type === "last") {
        const { turns } = parseTurns(raw);
        const n = range.count ?? 3;
        return turns
          .slice(-n)
          .map((t) => `${t.header}\n${t.content}`)
          .join("\n");
      }
      return raw;
    },
    readAgentTimeline: async (sid) => {
      const parsed = parseSliceId(sid);
      if (!parsed) return `(invalid slice: ${sid})`;
      return readRaw(
        `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/agent.md`,
      ).catch(() => `(agent.md not found: ${sid})`);
    },
    readPreviously: async (sid) => {
      const parsed = parseSliceId(sid);
      if (!parsed) return `(invalid slice: ${sid})`;
      return readRaw(
        `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/previously.md`,
      ).catch(() => `(previously not found: ${sid})`);
    },
  };
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
 *
 * When the user-clock context is provided, each tag's last-seen path carries a
 * local date + relative-days annotation (`rust（最近 07-24 周五 · 9 天前）` /
 * `rust (last 07-24 Fri · 9 days ago)`), so the agent never does date math.
 */
function buildStrandsMenu(
  strands: StrandIndex,
  time?: { nowIso?: string; timezone?: string; locale?: string },
): string {
  const entries = Object.entries(strands);

  if (entries.length === 0) return "";

  // Sort by most recent slice associated with each strand
  entries.sort((a, b) => {
    const aMax = a[1].reduce((max, p) => (p > max ? p : max), "");
    const bMax = b[1].reduce((max, p) => (p > max ? p : max), "");
    return bMax.localeCompare(aMax);
  });

  const zh = normalizeLocale(time?.locale) === "zh";
  const tagNames = entries.slice(0, 20).map(([name, paths]) => {
    if (!time?.nowIso || !time?.timezone) return name;
    const newest = paths.reduce((max, p) => (p > max ? p : max), "");
    const m = newest.match(/^(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})$/);
    if (!m) return name;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
    const localKey = localDateKey(iso, time.timezone);
    const phrase = relPhrase(iso, time.nowIso, time.timezone, time.locale ?? "en", {
      weekday: true,
    });
    if (!localKey || !phrase) return name;
    const mmdd = localKey.slice(5);
    return zh ? `${name}（最近 ${mmdd} ${phrase}）` : `${name} (last ${mmdd} ${phrase})`;
  });
  return `Known topics: ${tagNames.join(", ")}`;
}

/** Slice → continuity reference (end time comes from closeSlice's mutation). */
function toPrevRef(s: TimeSlice): PrevSliceRef {
  return { id: s.slice_id, focus: s.focus, start: s.start, end: s.end };
}

/**
 * Find the most recent closed slice from the canonical timeline catalog —
 * used for continuity when today has no active slice (cross-day return).
 * Reads `timeline/index.json` (structured); the markdown projection's format
 * changed in v0.8 and is not machine-scrapable. Returns null if the catalog
 * is unavailable or holds no closed slice.
 *
 * v0.9: `excludeFromId` bounds the search to slices that started BEFORE the
 * given slice id, so the continuity reference for an active slice is always
 * the slice that was closed just before it began — recomputed identically on
 * every turn of the slice (slice-head freeze).
 */
async function readMostRecentClosedSlice(
  excludeFromId?: string,
): Promise<PrevSliceRef | null> {
  try {
    const idx = await readTimelineIndex();
    if (!idx) return null;
    let newest: PrevSliceRef | null = null;
    for (const s of idx.slices) {
      if (s.status !== "closed") continue;
      if (excludeFromId && s.id >= excludeFromId) continue;
      if (newest && s.id <= newest.id) continue;
      newest = { id: s.id, focus: s.focus, start: s.start, end: s.end };
    }
    return newest;
  } catch {
    return null;
  }
}

// ─── Step 1: Housekeeping ────────────────────────────────────────────────

/**
 * Recover today's slice from GitHub truth (never the module global — it does
 * not survive across workflow invocations), close it on slice-age cap / turn
 * cap / context loss, or create a fresh one. Append the user turn and durably
 * snapshot before returning, so the message is on GitHub before we stream
 * anything.
 */
export async function housekeeping(input: TurnInput): Promise<HousekeepingResult> {
  "use step";

  // One reused writer + serial queue for every UI chunk this step emits —
  // fresh-writer-per-write races drop frames (see createStepStream).
  const stream = createStepStream();

  // ── Phase: slice — manage the time slice (recover/close/create) ─────
  await emitPhase(stream, "slice", true);

  const { config, clientTimezone, lastUserMessage, modelMessages } = input;

  // Peek at today's slice ONLY to derive the per-slice lock key (it may be
  // stale by the time the lock is acquired — the disk slice is re-loaded
  // inside). Single-process deployments serialize turns on the same slice
  // through this mutex; cross-process races are healed at commit time.
  const peeked = await tryLoadTodaySlice();
  const lockKey =
    peeked?.slice_id ?? `new-slice:${new Date().toISOString().slice(0, 10)}`;

  try {
  return await withSliceLock(lockKey, async () => {
  // ── Begin batch: all writes below go into ONE git commit. The batch is an
  // explicit object threaded through every call — never a module global, so
  // two turns in one process can't flush each other's writes. ─────────────
  const batch = createBatch();

  // ── v0.8: weave the timeline first (throttled). Its writes (index.json +
  // timeline.md) join this turn's batch; the full reconcile runs when the
  // catalog is stale or a slice just closed. The result feeds the timeline
  // brief for the system prompt.
  const weaveResult = await weaveTimeline({}, batch);
  if (!weaveResult.skipped) {
    console.log(
      `[Timeline] weave: +${weaveResult.added} -${weaveResult.removed} dry=${weaveResult.needs_marking} total=${weaveResult.total}`,
    );
  }

  let slice: TimeSlice;
  /** True when this call minted a fresh slice (vs restoring the active one) —
   *  the new slice must land in the timeline catalog within this turn's batch. */
  let createdNewSlice = false;
  /** The slice we came from — set when we close one this call, or resolved
   *  from the global timeline when today has none. Drives the continuity brief. */
  let prevSlice: PrevSliceRef | null = null;
  const diskSlice = await tryLoadTodaySlice(batch);

  // ── 1. Decide lifecycle (pure — no I/O, no LLM yet) ──────────────────
  let closeSignal: SlicingSignal | null = null;
  if (diskSlice && diskSlice.status === "active") {
    if (checkSliceAge(diskSlice.start, config.slicing.maxSliceMinutes * 60_000)) {
      closeSignal = "time_cap";
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      closeSignal = "capacity";
    } else if (checkContextLost(modelMessages, diskSlice)) {
      closeSignal = "context_lost";
    }
  }

  // ── 2. One analyze pass: message tags + semantic hint + (on close) marking ──
  // Phase: analyze — the turn-analyzer sub-agent pass (main model via the
  // shared runner, v0.9) is its own visible housekeeping sub-step.
  await emitPhase(stream, "analyze", true);
  const existingStrands = await readStrands(batch);
  const analysis = await analyzeTurn({
    model: input.modelConfig,
    userMessage: lastUserMessage,
    existingStrandNames: Object.keys(existingStrands),
    closingSlice:
      closeSignal && diskSlice
        ? { turns: diskSlice.turns, tags: diskSlice.tags }
        : undefined,
  });
  const candidateTags = analysis.memoryWorthy
    ? [
        ...analysis.messageTags.reuse,
        ...analysis.messageTags.create.map((c) => c.tag),
      ]
    : [];
  await emitPhase(
    stream,
    "analyze",
    false,
    candidateTags.length > 0 ? candidateTags : undefined,
  );

  // ── 3. Execute lifecycle — close marking is applied BEFORE the slice persists ──
  if (closeSignal && diskSlice) {
    if (analysis.closedMarking) {
      if (analysis.closedMarking.focus) diskSlice.focus = analysis.closedMarking.focus;
      if (analysis.closedMarking.summary) diskSlice.summary = analysis.closedMarking.summary;
      if (analysis.closedMarking.tags.length > 0) diskSlice.tags = analysis.closedMarking.tags;
      if (analysis.closedMarking.tone) diskSlice.emotional_tone = analysis.closedMarking.tone;
    }
    // v0.8 reliability: never close a slice dry when it has content. The
    // analyzer silently returns EMPTY on any failure (worker outage, schema
    // mismatch), which used to leave focus/summary empty — the "39% dry"
    // timeline. Fill any gap with a deterministic mark from the slice itself.
    if (!diskSlice.focus || !diskSlice.summary) {
      const fallback = deterministicSliceMark(diskSlice);
      if (!diskSlice.focus) diskSlice.focus = fallback.focus;
      if (!diskSlice.summary) diskSlice.summary = fallback.summary;
      console.log(
        `[Episodic] ${diskSlice.slice_id} closed with deterministic mark (analyzer output incomplete)`,
      );
    }
    prevSlice = toPrevRef(diskSlice);
    await closeSlice(diskSlice, closeSignal, batch);
    console.log(`[Episodic] Closed slice: ${diskSlice.slice_id} (${closeSignal})`);
    // Signal the client that a slice closed (rendered as a housekeeping
    // checklist row). The per-slice evolution itself runs INLINE below
    // (§4b) — the client no longer fires anything on this signal.
    await emitPhase(stream, "slice-closed", false, [diskSlice.slice_id]);
    // v0.8 — force the reconcile so the just-closed slice is in the projection
    // immediately (the throttled per-turn weave would defer it up to 5 min).
    await weaveTimeline({ force: true }, batch);

    // Strand consolidation (opportunistic, on slice close): prune single-use
    // stale strands deterministically; when the index is large enough, ask the
    // model (main model via the shared runner, v0.9) for a from→to merge map
    // to collapse semantic duplicates
    // (typos / same-concept-two-names) that deterministic normalization can't
    // catch. Writes land in the current batch → one commit with the close.
    const strandsBefore = await readStrands(batch);
    const { strands: consolidated, pruned, merges, llmPassSkipped } =
      await consolidateStrands(strandsBefore, input.modelConfig);
    if (pruned.length > 0 || merges.length > 0) {
      await fsWriteFile(getStrandsPath(), serializeStrands(consolidated), batch);
      console.log(
        `[Strands] Consolidation: pruned ${pruned.length}, merged ${merges.length}` +
        (llmPassSkipped ? " (llm skipped)" : ""),
      );
    }

    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    createdNewSlice = true;
  } else if (diskSlice && diskSlice.status === "active") {
    slice = diskSlice;
    console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    createdNewSlice = true;
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
  }

  // ── 3b. Dry-slice backfill (opportunistic, only on a close boundary) ────
  // Slices that closed dry (needs_marking) never got their semantics rewritten
  // — pick up to 3 from the catalog and mark them from their core.md (main
  // model via the shared runner, v0.9), inside this turn's batch. Best-effort:
  // failures skip silently, the active slice is never touched, and demo mode
  // is skipped entirely (its writes are no-ops — no reason to spend the calls).
  if (closeSignal && diskSlice && !input.useDemo) {
    try {
      const marked = await backfillDrySliceMarks({
        model: input.modelConfig,
        excludeSliceIds: [slice.slice_id, diskSlice.slice_id],
        batch,
      });
      if (marked > 0) {
        console.log(`[Timeline] backfilled marks for ${marked} dry slice(s)`);
      }
    } catch {
      // best-effort — never take a turn down
    }
  }

  // ── 4. Apply the current message's tags to the active slice ──────────
  // Merge-first at the slice boundary too: `reuse` tags must resolve to an
  // existing strand (a hallucinated name is dropped, never minted); `create`
  // tags are folded into an existing strand via normalized-match before a new
  // key is ever allowed. This keeps a slice's accumulated tags from inventing
  // near-duplicate strands mid-slice (they'd otherwise hit strands.json before
  // the close-time cleaning replaces them).
  // Phase: tags — the analyzer (above) found them; this step applies them.
  await emitPhase(stream, "tags", true);
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
  await emitPhase(stream, "tags", false, appliedTags);

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
  await emitPhase(stream, "slice", false, [slice.slice_id]);

  // ── Phase: context — load the user profile (previously + identity) ───
  await emitPhase(stream, "context", true);

  // ── 4b. Card evolution (v0.7b / v5, mutation-based) ─────────────────────
  // ONE pass, owned by the Previously Agent. Engineering owns the TRIGGER
  // only; every content decision (expiry, overdue handling, caps, format)
  // belongs to the agent, enforced INSIDE its write tools — there is no
  // mechanical pass that silently edits the card.
  // Triggers:
  //   (a) slice boundary — gated by the ANALYZER's judgment (evolveCard.worth);
  //       on analyzer failure the gate defaults to running (a wasted worker
  //       call is cheap, a missed evolution is permanent memory loss). A
  //       LEGACY (pre-v5) card FORCES a run so format migration never waits
  //       for a "worthy" boundary. When skipped, a terminal data-evolution
  //       chunk (status "done") is still emitted so the skip stays visible
  //       (with the reason).
  //   (b) the user explicitly asking to record/evolve, or stating an explicit
  //       behavioral correction (analyzeTurn's memoryUpdate).
  // The run is INLINE (blocking) so the new slice's card is the
  // freshly-evolved one. Progress streams to the client; the result's summary
  // is frozen into the new slice's frontmatter (evolution_summary) so the L3
  // slice-head block can replay it on every turn of the slice.
  // Demo mode is skipped entirely — it is a read-only preview and must never
  // write the real card (the old /api/evolution route also returned skipped).
  let evolutionResult: EvolutionResult | undefined;
  const explicitUpdate = analysis.memoryUpdate;
  // Ages/overdue compare against the USER's local calendar date, not UTC.
  const todayLocal =
    localDateKey(input.startedAtIso, input.clientTimezone) ?? undefined;
  /** Freeze a changed evolution's summary into the slice (single line, YAML-safe). */
  const freezeEvolutionSummary = (target: TimeSlice) => {
    if (evolutionResult?.ran && evolutionResult.changed && evolutionResult.summary) {
      target.evolutionSummary = evolutionResult.summary.replace(/\s+/g, " ").trim();
    }
  };
  // Evolution failures must never take the turn down: a write/agent error is
  // reported to the client as an error chunk and the turn continues.
  //
  // Live thinking channel: the Previously Agent streams its reasoning/writing
  // through onEvolutionLine → throttled (40ms, same discipline as tool
  // progress) data-evolution frames carrying the current line. The phase step
  // ("reading" → "reviewing") rides along; the "applied" step is folded into
  // the terminal result chunk, which follows immediately.
  let evolutionLiveState: ProgressWriteState = {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
  };
  let evolutionStep: "reading" | "reviewing" = "reading";
  const onEvolutionProgress = (step: "reading" | "reviewing" | "applied") => {
    if (step === "applied") return; // the terminal result chunk follows
    evolutionStep = step;
    emitEvolutionProgress(stream, step);
  };
  const onEvolutionLine = (line: string, stage: "thinking" | "writing") => {
    const now = Date.now();
    if (!shouldEmitProgress(evolutionLiveState, { line, stage }, now)) return;
    evolutionLiveState = {
      lastWriteMs: now,
      lastLine: line,
      lastStage: stage,
      sentAny: true,
    };
    emitEvolutionProgress(stream, evolutionStep, line, stage);
  };
  try {
    if (!input.useDemo && closeSignal && diskSlice) {
      // Read-only fact for the trigger.
      const cardRaw = await readCurrentPreviously(batch);
      // A legacy (pre-v5) card forces the run — migration must not wait for a
      // "worthy" boundary.
      const legacyCard =
        cardRaw.trim().length > 0 && !cardRaw.includes(CARD_STAMP);

      if (shouldRunCardEvolution(analysis) || legacyCard) {
        evolutionResult = await runCardEvolution({
          model: input.modelConfig,
          sliceId: diskSlice.slice_id,
          closedSliceId: diskSlice.slice_id,
          recentTurns: diskSlice.turns.map((t) => ({ role: t.role, content: t.content })),
          currentSliceTags: diskSlice.tags,
          signal: "slice_closed",
          focus: explicitUpdate?.content,
          readers: buildCardReaders(input),
          onProgress: onEvolutionProgress,
          onEvolutionLine,
          batch,
          todayDate: todayLocal,
        });
        await emitEvolutionResult(stream, evolutionResult);
        freezeEvolutionSummary(slice);
        console.log(
          `[Evolution] inline slice-close: changed=${evolutionResult.changed}${legacyCard ? " (legacy card migration)" : ""}`,
        );
      } else {
        // Analyzer-judged skip — still emit a terminal chunk so the
        // auto-evolution stays visibly alive (a silent skip reads as "it
        // never runs"), with the reason recorded.
        await emitEvolutionResult(stream, {
          ran: false,
          changed: false,
          droppedRecent: 0,
          note: `Slice boundary — nothing worth sedimenting (${analysis.evolveCard?.reason ?? "no reason given"}).`,
        });
      }
    } else if (explicitUpdate && slice) {
      evolutionResult = await runCardEvolution({
        model: input.modelConfig,
        sliceId: slice.slice_id,
        recentTurns: input.recentTurns,
        currentSliceTags: slice.tags,
        focus: explicitUpdate.content,
        signal: "new_observation",
        readers: buildCardReaders(input),
        onProgress: onEvolutionProgress,
        onEvolutionLine,
        batch,
        todayDate: todayLocal,
      });
      await emitEvolutionResult(stream, evolutionResult);
      freezeEvolutionSummary(slice);
      console.log(
        `[Evolution] inline user request: changed=${evolutionResult.changed}`,
      );
    }
  } catch (err) {
    console.error(
      `[Evolution] inline run failed, continuing turn:`,
      err instanceof Error ? err.message : err,
    );
    await emitEvolutionResult(stream, {
      ran: false,
      changed: false,
      droppedRecent: 0,
      note: "Evolution run failed.",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 4. Ensure previously.md (pure copy forward, no decay) ────────────
  const previouslyContent = await ensurePreviously(slice.slice_id, batch);
  console.log(`[Previously] Seeded previously.md for ${slice.slice_id}`);

  // ── 5. Durable snapshot + index/strand maintenance ───────────────────
  await saveSliceSnapshot(slice, batch);
  await ensureIndexEntries(slice, batch);
  await generateGlobalTimeline(batch);
  // A slice created THIS turn must appear in the timeline catalog within the
  // same commit — the throttled per-turn weave above would otherwise defer it
  // up to WEAVE_FRESH_MS. A direct upsert is cheaper than a forced weave.
  if (createdNewSlice) {
    await upsertTimelineEntry(slice, batch);
  }

  // Commit all queued writes as one commit before building the menu
  // (which reads strands.json) and opening the UI stream.
  await flushBatch(batch, `Turn ${input.turnId} — housekeeping`);

  // ── Phase: strands — weave the memory-topic index ────────────────────
  await emitPhase(stream, "strands", true);
  const strands = await readStrands();
  // Anchored to the SLICE START (not "now") so the relative-day annotations
  // stay byte-stable for the slice's whole life (v0.9 prefix-cache freeze).
  const strandsMenu = buildStrandsMenu(strands, {
    nowIso: slice.start,
    timezone: input.clientTimezone,
    locale: input.locale,
  });
  await emitPhase(stream, "strands", false, [`${Object.keys(strands).length} strands`]);

  // ── 6b. Continuity + slice-head snapshot + identity ──────────────────
  // v0.9 slice-level prompt freeze: the continuity stance is computed at the
  // SLICE'S BIRTH, not per turn — the reference is the newest slice closed
  // before this one began (a slice we closed this call, else the catalog),
  // and the gap is measured against `slice.start`. Recomputed this way on
  // every turn, the resulting line is byte-identical for the slice's life.
  if (!prevSlice) {
    prevSlice = await readMostRecentClosedSlice(slice.slice_id);
  }
  const continuity = classifyContinuity(slice.start, prevSlice, false);

  // The frozen L3 block — see buildSliceHeadBlock (src/lib/turn-priming.ts).
  // The evolution summary rides the slice frontmatter, so a restored slice
  // replays the exact line written at its birth.
  const sliceHeadBlock = buildSliceHeadBlock({
    sliceStartIso: slice.start,
    clientTimezone: input.clientTimezone,
    locale: input.locale,
    continuity,
    evolutionSummary: slice.evolutionSummary,
  });

  // The agent's constitution (SOUL + who-you're-assisting + DIRECTIVES),
  // derived from the already-loaded previously.md identity section.
  const profile = parseIdentityFromPreviously(previouslyContent);
  const identityPrompt = buildAgentIdentityPrompt(profile);

  await emitPhase(stream, "context", false, [`continuity: ${continuity.tier}`]);

  // ── 7. Open UI stream ────────────────────────────────────────────────
  await stream.write({ type: "start" } as UIMessageChunk);
  await stream.write({ type: "start-step" } as UIMessageChunk);

  // ── v0.8: assemble the timeline brief for the system prompt — recent slice
  // pointer lines + catalog totals. Pure pointers, never content.
  // v0.9: FROZEN mode (asOfSliceId) — absolute dates and only slices closed
  // before this one began, so the brief can't drift mid-slice.
  const timelineIndex = await readTimelineIndex();
  const timelineBrief = timelineIndex
    ? buildTimelineBrief(timelineIndex, {
        timezone: input.clientTimezone,
        locale: input.locale,
        asOfSliceId: slice.slice_id,
      })
    : "";

  return {
    slice,
    previouslyContent,
    strandsMenu,
    sliceHeadBlock,
    identityPrompt,
    ...(timelineBrief ? { timelineBrief } : {}),
  };
  });
  } finally {
    // Release the step's writer lock so the step's HTTP request can terminate
    // and later steps (agent reply, finalizeTurn) can acquire their own.
    stream.close();
  }
}

// ─── Step 2: Finalize turn ───────────────────────────────────────────────

/**
 * How many times a conflicting flush re-reads the remote slice, merges, and
 * retries the commit before giving up (and failing the step → queue retry).
 */
const MAX_FLUSH_RETRIES = 2;

/**
 * Flush the turn's batch with write-conflict self-heal.
 *
 * `commitBatchToGitHub` does a non-force updateRef: when another turn (or
 * process) commits between our read and our commit, the update is rejected as
 * non-fast-forward. Slice turns are append-only, so the heal is mechanical —
 * re-read the REMOTE core.md, merge-append this turn's missing entries by
 * turnId, swap the merged file into the batch, and retry the commit.
 */
async function flushTurnBatch(
  batch: WriteBatch,
  message: string,
  slice: TimeSlice,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await flushBatch(batch, message);
      return;
    } catch (err) {
      if (!isRefConflictError(err) || attempt >= MAX_FLUSH_RETRIES) {
        throw err;
      }
      const corePath = sliceIdToFilePath(slice.slice_id);
      try {
        // The read cache may still hold OUR stale base — drop it so the
        // re-read sees the commit that beat us.
        const { owner, repo } = getRepoConfig();
        invalidateReadCache(corePath, repo, owner);
        const remoteRaw = await fsReadFile(corePath);
        batch.entries.set(corePath, mergeTurnsWithRemote(remoteRaw, slice));
        console.warn(
          `[Episodic] flush conflict on ${corePath} — merged remote turns, retrying (${attempt + 1}/${MAX_FLUSH_RETRIES})`,
        );
      } catch (mergeErr) {
        // Remote slice unreadable (deleted?) — retry the commit as-is.
        console.warn(
          `[Episodic] flush conflict on ${corePath} — remote re-read failed, retrying as-is:`,
          mergeErr instanceof Error ? mergeErr.message : mergeErr,
        );
      }
    }
  }
}

/**
 * Persist the agent turn to the episodic slice (the old streamText onFinish)
 * and close the run's output stream with the trailing lifecycle chunks.
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

  // Serialize turns on the same slice within this process (see housekeeping).
  return withSliceLock(slice.slice_id, async () => {

  // ── Begin batch: all writes below go into ONE git commit ──────────────
  const batch = createBatch();

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

  if (outcome.finishReason === "stop" || outcome.text) {
    await saveSliceSnapshot(slice, batch);
    // Index/timeline refresh is unconditional (was: stop-only) — an
    // interrupted turn's partial text still belongs in the indexes.
    await ensureIndexEntries(slice, batch);
    await generateGlobalTimeline(batch);
  }

  // 2b. Write agent timeline — mechanical extraction from the model's own
  // reasoning traces and tool calls. The cognition body is produced by
  // extractCognition() in the workflow body; here we prepend the header
  // (timestamp stamped in this step, where Date is allowed) and persist.
  if (outcome.cognition) {
    const header = `## Cognition ${turnId} — ${new Date().toISOString()}\n`;
    await writeAgentTimeline(slice.slice_id, header + outcome.cognition, batch);
  }

  // Commit all queued writes as one commit before closing the stream.
  await flushTurnBatch(batch, `Turn ${turnId} — agent response`, slice);

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
  });
}
