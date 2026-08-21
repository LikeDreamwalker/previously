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
import {
  parseCard,
  findOverdueHorizonItems,
  CARD_STAMP,
  type CardHorizonItem,
} from "@/lib/episodic/previously-format";
import {
  localDateKey,
  normalizeLocale,
  relPhrase,
} from "@/lib/time/relative";


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

/** Emit a data-evolution progress chunk so the client's EvolutionIndicator shows the inline run. */
async function emitEvolutionProgress(
  step: "reading" | "reviewing" | "applied",
): Promise<void> {
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution-progress",
    data: { running: true, step },
  } as UIMessageChunk);
  writer.releaseLock();
}

/** Emit the terminal evolution-result chunk with the change summary. */
async function emitEvolutionResult(result: EvolutionResult): Promise<void> {
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution-result",
    data: {
      running: false,
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
    },
  } as UIMessageChunk);
  writer.releaseLock();
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
 */
async function readMostRecentClosedSlice(): Promise<PrevSliceRef | null> {
  try {
    const idx = await readTimelineIndex();
    if (!idx) return null;
    let newest: PrevSliceRef | null = null;
    for (const s of idx.slices) {
      if (s.status !== "closed") continue;
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

  // Peek at today's slice ONLY to derive the per-slice lock key (it may be
  // stale by the time the lock is acquired — the disk slice is re-loaded
  // inside). Single-process deployments serialize turns on the same slice
  // through this mutex; cross-process races are healed at commit time.
  const peeked = await tryLoadTodaySlice();
  const lockKey =
    peeked?.slice_id ?? `new-slice:${new Date().toISOString().slice(0, 10)}`;

  return withSliceLock(lockKey, async () => {
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
  const existingStrands = await readStrands(batch);
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
    await emitPhase("slice-closed", false, [diskSlice.slice_id]);
    // v0.8 — force the reconcile so the just-closed slice is in the projection
    // immediately (the throttled per-turn weave would defer it up to 5 min).
    await weaveTimeline({ force: true }, batch);

    // Strand consolidation (opportunistic, on slice close): prune single-use
    // stale strands deterministically; when the index is large enough, ask the
    // worker model for a from→to merge map to collapse semantic duplicates
    // (typos / same-concept-two-names) that deterministic normalization can't
    // catch. Writes land in the current batch → one commit with the close.
    const strandsBefore = await readStrands(batch);
    const { strands: consolidated, pruned, merges, llmPassSkipped } =
      await consolidateStrands(strandsBefore, input.workerModel);
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
  // — pick up to 3 from the catalog and let the worker model mark them from
  // their core.md, inside this turn's batch. Best-effort: failures skip
  // silently, the active slice is never touched, and demo mode is skipped
  // entirely (its writes are no-ops — no reason to spend worker calls).
  if (closeSignal && diskSlice && !input.useDemo) {
    try {
      const marked = await backfillDrySliceMarks({
        model: input.workerModel,
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
  // Dedup by turnId (user and agent turns of a round share it — scope the
  // check to role): a redelivered workflow run finds its user turn already
  // persisted and skips the append. Legacy turns parsed from old files carry
  // no turnId, so the content check below stays as the fallback (mirrors the
  // turnKey fallback in lib/episodic/turn-merge.ts).
  const isNewSlice =
    slice.turns.length === 1 && slice.turns[0].content === lastUserMessage;
  const userTurnRecorded =
    !!input.turnId &&
    slice.turns.some((t) => t.role === "user" && t.turnId === input.turnId);
  if (!isNewSlice && !userTurnRecorded) {
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
  //       for a "worthy" boundary. When skipped, a terminal evolution-result
  //       chunk is still emitted so the skip stays visible (with the reason).
  //   (b) the user explicitly asking to record/evolve, or stating an explicit
  //       behavioral correction (analyzeTurn's memoryUpdate).
  // Overdue Horizon items are computed READ-ONLY here for turn priming —
  // resolving them is the agent's job. The run is INLINE (blocking) so the
  // new slice's card is the freshly-evolved one. Progress streams to the
  // client; the result is returned for the agent to acknowledge.
  // Demo mode is skipped entirely — it is a read-only preview and must never
  // write the real card (the old /api/evolution route also returned skipped).
  let evolutionResult: EvolutionResult | undefined;
  let overdueHorizon: CardHorizonItem[] | undefined;
  const explicitUpdate = analysis.memoryUpdate;
  // Ages/overdue compare against the USER's local calendar date, not UTC.
  const todayLocal =
    localDateKey(input.startedAtIso, input.clientTimezone) ?? undefined;
  // Evolution failures must never take the turn down: a write/agent error is
  // reported to the client as an error chunk and the turn continues.
  try {
    if (!input.useDemo && closeSignal && diskSlice) {
      // Read-only facts for the trigger and for turn priming.
      const cardRaw = await readCurrentPreviously(batch);
      const cardDoc = cardRaw.trim() ? parseCard(cardRaw) : null;
      if (cardDoc && todayLocal) {
        const overdue = findOverdueHorizonItems(cardDoc, todayLocal);
        if (overdue.length > 0) {
          overdueHorizon = overdue;
          console.log(`[Evolution] overdue horizon items: ${overdue.length}`);
        }
      }
      // A legacy (pre-v5) card forces the run — migration must not wait for a
      // "worthy" boundary.
      const legacyCard =
        cardRaw.trim().length > 0 && !cardRaw.includes(CARD_STAMP);

      if (shouldRunCardEvolution(analysis) || legacyCard) {
        evolutionResult = await runCardEvolution({
          model: input.workerModel,
          sliceId: diskSlice.slice_id,
          closedSliceId: diskSlice.slice_id,
          recentTurns: diskSlice.turns.map((t) => ({ role: t.role, content: t.content })),
          currentSliceTags: diskSlice.tags,
          signal: "slice_closed",
          focus: explicitUpdate?.content,
          readers: buildCardReaders(input),
          onProgress: emitEvolutionProgress,
          batch,
          todayDate: todayLocal,
        });
        await emitEvolutionResult(evolutionResult);
        console.log(
          `[Evolution] inline slice-close: changed=${evolutionResult.changed}${legacyCard ? " (legacy card migration)" : ""}`,
        );
      } else {
        // Analyzer-judged skip — still emit a terminal chunk so the
        // auto-evolution stays visibly alive (a silent skip reads as "it
        // never runs"), with the reason recorded.
        await emitEvolutionResult({
          ran: false,
          changed: false,
          droppedRecent: 0,
          note: `Slice boundary — nothing worth sedimenting (${analysis.evolveCard?.reason ?? "no reason given"}).`,
        });
      }
    } else if (explicitUpdate && slice) {
      evolutionResult = await runCardEvolution({
        model: input.workerModel,
        sliceId: slice.slice_id,
        recentTurns: input.recentTurns,
        currentSliceTags: slice.tags,
        focus: explicitUpdate.content,
        signal: "new_observation",
        readers: buildCardReaders(input),
        onProgress: emitEvolutionProgress,
        batch,
        todayDate: todayLocal,
      });
      await emitEvolutionResult(evolutionResult);
      console.log(
        `[Evolution] inline user request: changed=${evolutionResult.changed}`,
      );
    }
  } catch (err) {
    console.error(
      `[Evolution] inline run failed, continuing turn:`,
      err instanceof Error ? err.message : err,
    );
    await emitEvolutionResult({
      ran: false,
      changed: false,
      droppedRecent: 0,
      note: "Evolution run failed.",
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
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
  await emitPhase("strands", true);
  const strands = await readStrands();
  const strandsMenu = buildStrandsMenu(strands, {
    nowIso: input.startedAtIso,
    timezone: input.clientTimezone,
    locale: input.locale,
  });
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
    emotionalSignal: analysis.emotionalSignal,
    locale: input.locale,
    overdueHorizon,
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

  // ── v0.8: assemble the timeline brief for the system prompt — recent slice
  // pointer lines + catalog totals. Pure pointers, never content.
  const timelineIndex = await readTimelineIndex();
  const timelineBrief = timelineIndex
    ? buildTimelineBrief(timelineIndex, {
        nowIso: input.startedAtIso,
        timezone: input.clientTimezone,
        locale: input.locale,
      })
    : "";

  return {
    slice,
    previouslyContent,
    strandsMenu,
    turnPriming,
    identityPrompt,
    ...(timelineBrief ? { timelineBrief } : {}),
    ...(evolutionResult ? { evolutionResult } : {}),
    ...(overdueHorizon ? { overdueHorizon } : {}),
  };
  });
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
 * Persist the agent turn to the episodic slice (the old streamText onFinish),
 * write back pointers for any loops the agent started this turn, and close the
 * run's output stream with the trailing lifecycle chunks.
 *
 * The agent streamed with `sendFinish: false` + `preventClose: true`, so this
 * step owns the stream tail — finish-step / finish, then close. Retries are
 * safe: the agent-turn append is deduped by turnId, and the snapshot write is
 * idempotent.
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
  // Idempotent under redelivery: when this turnId's agent turn is already in
  // the slice (a retried run re-executing against persisted disk state), skip
  // the append. User and agent turns share the turnId — scope by role.
  const agentTurnRecorded =
    !!turnId &&
    slice.turns.some((t) => t.role === "agent" && t.turnId === turnId);
  if (agentTurnRecorded) {
    console.log(`[Episodic] Agent turn ${turnId} already persisted — skipping append`);
  } else if (outcome.finishReason === "stop") {
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
