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
  loadSlice,
  type TimeSlice,
  type StrandIndex,
  type SlicingSignal,
  type TurnAnalysis,
  type WriteBatch,
} from "@/lib/episodic";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { mergeTurnsWithRemote } from "@/lib/episodic/turn-merge";
import { isRefConflictError } from "@/lib/tools/batch-write";
import { getRepoConfig } from "@/lib/capabilities";
import {
  consolidateStrands,
  MIN_STRANDS_FOR_LLM,
} from "@/lib/episodic/flash/strand-consolidator";
import { applyStrandMerges, pruneStrands } from "@/lib/episodic/strands";
import {
  adaptHousekeepingReport,
  applyBridgeCardEvolution,
  degradedAnalysis,
  isPhaseOutsourceActive,
  runHousekeepingBridge,
  type HousekeepingPhaseReport,
} from "@/lib/bridge-phases";
import {
  createBridgeEventEmitter,
  type BridgePhaseData,
} from "@/lib/models/bridge-model";
import type { HousekeepingStep } from "@/lib/chat/build-stream";
import {
  applyMarksToDrySlices,
  backfillDrySliceMarks,
  collectDrySliceCandidates,
} from "@/lib/episodic/flash/backfill-marks";
import { checkSliceAge, checkIdleGap } from "@/lib/episodic/slicer";
import { fsReadFile, fsWriteFile } from "@/lib/episodic/io-helpers";
import {
  appendFitnessEvents,
  appendMutation,
  bucketNetScore,
  emptyFitnessStore,
  ensureEvolutionFiles,
  readDirection,
  readFitness,
  readRecentSignals,
  recordDirectionRejection,
  resetFitnessGeneration,
  writeDirection,
} from "@/lib/evolution/store";
import { logInteractionSignal } from "@/lib/episodic/rework-signal";
import { computeEvolutionTriggers } from "@/lib/evolution/triggers";
import {
  DIRECTION_RECENT_EVENTS,
  DIRECTION_RECENT_MARKINGS,
  buildDirectionBlock,
  detectDirectionMode,
  extractDirectionSection,
  validateDirectionProposal,
} from "@/lib/evolution/direction-agent";
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
import { CARD_STAMP, parseCard } from "@/lib/episodic/previously-format";
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
  step: "direction" | "reading" | "reviewing",
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
      // v1.0 calibration details (design §2.3/§2.5): why the run fired, the
      // direction verdict (v1.1 merged run — evaluated inside the one
      // runCardEvolution call), and the playbook mutations applied. All
      // optional — absent on analyzer-gated / explicit-request / bridge runs.
      ...(result.triggers?.length ? { triggers: result.triggers } : {}),
      ...(result.direction ? { direction: result.direction } : {}),
      ...(result.playbooks?.length ? { playbooks: result.playbooks } : {}),
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
 * How many trailing turns of a checkpointed previous slice are carried into
 * the new slice's history window (see the contextPrefix block below).
 */
const CHECKPOINT_CARRY_OVER_TURNS = 10;

/** Cap on the direction Portrait section fed to the turn-analyzer as Task 7's
 *  scoring rubric (v1.1) — it rides the USER prompt of every analysis call. */
const ANALYZER_PORTRAIT_MAX_CHARS = 4000;

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

  // ── Phase display: two modes, two components ─────────────────────────
  // Edge mode emits one compact data-phase chunk per engineering sub-step
  // (slice / analyze / tags / context / strands) — the client merges them
  // into the HousekeepingCard checklist.
  // Client (outsourced) mode renders ONE streaming card instead: the whole
  // phase is a single agent call + deterministic wrap-up, so the card
  // streams the CLI's live activity (tool rows + narration line, fed by the
  // bridge emitter below) and fills in wrap-up rows as the engineering
  // steps complete — the edge checklist is NOT emitted (it would sit idle
  // through the whole call, then jump to done).
  // The gate also requires the turn's model to run on the bridge — a BYOK
  // model (sdk "openai") under a bridge env brain keeps housekeeping on the
  // standard API sub-agent path.
  const phaseOutsource = isPhaseOutsourceActive(input.modelConfig.sdk);
  /** Wrap-up rows of the client-mode card (same shape as the checklist). */
  const hkSteps: HousekeepingStep[] = [];
  /** Last bridge-emitter frame state, folded into every card frame. */
  const hkActivity: {
    tools: BridgePhaseData["tools"];
    live?: string;
    /** Set when the bridge call failed and the turn degraded to the
     *  deterministic path — the card shows an amber warning. */
    warning?: string;
  } = {
    tools: [],
  };
  const sendHousekeepingCard = (running: boolean) =>
    stream.send({
      type: "data-phase" as `data-${string}`,
      id: "phase-bridge-housekeeping",
      data: {
        phase: "bridgeHousekeeping",
        running,
        summaries: [],
        tools: hkActivity.tools,
        ...(hkActivity.live ? { live: hkActivity.live } : {}),
        ...(hkActivity.warning ? { warning: hkActivity.warning } : {}),
        steps: hkSteps.map((s) => ({ ...s })),
      },
    } as UIMessageChunk);
  /** Phase display dispatch: edge → compact checklist chunk; client → a
   *  wrap-up row inside the bridge housekeeping card. */
  const emitStep = async (
    phase: string,
    running: boolean,
    summaries?: string[],
  ): Promise<void> => {
    if (!phaseOutsource) return emitPhase(stream, phase, running, summaries);
    const existing = hkSteps.find((s) => s.phase === phase);
    if (existing) {
      existing.running = running;
      if (summaries !== undefined) existing.summaries = summaries;
    } else {
      hkSteps.push({
        phase,
        running,
        ...(summaries !== undefined ? { summaries } : {}),
      });
    }
    sendHousekeepingCard(hkSteps.some((s) => s.running));
  };

  // ── Phase: slice — manage the time slice (recover/close/create) ─────
  await emitStep("slice", true);

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
    // Idle gap FIRST: a long silence since the last turn means the user left
    // and came back — this is a genuinely new conversation, not a checkpoint.
    // (Closes are lazy: this fires on the first turn after the gap.)
    const lastTurnTs = diskSlice.turns.at(-1)?.timestamp;
    if (
      lastTurnTs &&
      checkIdleGap(lastTurnTs, config.slicing.idleGapMinutes * 60_000)
    ) {
      closeSignal = "idle_gap";
    } else if (checkSliceAge(diskSlice.start, config.slicing.maxSliceMinutes * 60_000)) {
      // The age cap is a periodic autosave CHECKPOINT, not a conversation end
      // — the new slice continues the same one (continuesFrom below).
      closeSignal = "time_cap";
    } else if (diskSlice.turns.length >= config.slicing.maxTurnsPerSlice) {
      closeSignal = "capacity";
    // A regenerate turn legitimately carries NO assistant message in its
    // client history (the SDK truncated the rejected reply) — the counting
    // heuristic would misread a first-turn regenerate as context loss, so it
    // is skipped for this turn shape.
    } else if (!input.regenerate && checkContextLost(modelMessages, diskSlice)) {
      closeSignal = "context_lost";
    }
  }

  // ── 2. One analyze pass: message tags + semantic hint + (on close) marking ──
  // Phase: analyze — the turn-analyzer sub-agent pass (main model via the
  // shared runner, v0.9) is its own visible housekeeping sub-step.
  await emitStep("analyze", true);
  const existingStrands = await readStrands(batch);
  // This slice's mechanical fitness signals (v1.0 §2.6 — recall verify/rework
  // instrumentation) ride the analyzer input (Task 7) and the bridge payload.
  const thisSliceSignals = diskSlice
    ? (await readRecentSignals(20)).filter(
        (s) => s.sliceId === diskSlice.slice_id,
      )
    : [];
  // Phase outsourcing (client mode + bridge brain, kill-switch
  // PREVIOUSLY_PHASE_OUTSOURCE=0): ONE bridge call covers BOTH LLM stages —
  // the turn analysis AND the card-evolution proposal (applied in §4b via
  // bridgeReport). The card is read here for the payload and reused in §4b.
  // A failed call degrades EXACTLY like an analyzer outage (memoryWorthy=true,
  // no tags, deterministic closed marking below) and additionally SKIPS the
  // evolution — no second bridge spawn on a broken bridge.
  let analysis: TurnAnalysis;
  let bridgeReport: HousekeepingPhaseReport | null = null;
  let bridgeCardRaw: string | undefined;
  /** The direction doc, read for the bridge payload (reused when applying the
   *  report's direction outcome in §4b). */
  let bridgeDirection: string | null = null;
  /** The card's legacy Self-model lines + the direction mode, offered to the
   *  bridge call so its direction verdict follows the same discipline. */
  let bridgeSelfModel: string | null = null;
  let bridgeDirectionMode: "bootstrap" | "migrate" | "steady" = "steady";
  /** Dry-slice ids offered to the bridge call — the apply step (§3b) honors
   *  backfill marks for exactly these ids, never anything the agent invented. */
  let bridgeDryCandidateIds: string[] = [];
  /** True when the bridge call was offered strand merge candidates (close
   *  boundary + post-prune index ≥ MIN_STRANDS_FOR_LLM — the consolidator's
   *  own gate) — the apply step (§close) honors strand_merges only when the
   *  offer was actually made. */
  let bridgeStrandMergeOffered = false;
  /** The offered strand names — the apply step honors a merge only when BOTH
   *  keys were actually offered (same discipline as backfill candidate ids). */
  let bridgeStrandMergeNames: Set<string> | null = null;
  if (phaseOutsource) {
    bridgeCardRaw = await readCurrentPreviously(batch);
    bridgeDirection = await readDirection();
    // Legacy Self-model lines (migration source) + the bootstrap/migrate/
    // steady mode ride the payload so the outsourced direction verdict follows
    // the same discipline as the merged evolution run (v1.1 §6).
    const bridgeCardDoc = parseCard(bridgeCardRaw);
    bridgeSelfModel =
      bridgeCardDoc && bridgeCardDoc.selfModel.length > 0
        ? bridgeCardDoc.selfModel.map((s) => `- ${s}`).join("\n")
        : null;
    bridgeDirectionMode = detectDirectionMode(bridgeDirection);
    // Dry-slice re-marking rides the SAME bridge call (job 4 of the report)
    // instead of the old per-slice backfill sub-agent spawns — on a close
    // boundary the candidates are gathered here and marked via the report.
    const dryCandidates =
      closeSignal && diskSlice && !input.useDemo
        ? await collectDrySliceCandidates({
            excludeSliceIds: [diskSlice.slice_id],
            batch,
          })
        : [];
    bridgeDryCandidateIds = dryCandidates.map((d) => d.sliceId);
    // Strand semantic dedupe rides the SAME call too (job 5), replacing the
    // old strand-consolidator sub-agent pass — same gate (close boundary +
    // POST-PRUNE index big enough), offered with slice counts so the agent
    // can prefer the more-used name as the merge target.
    const prunedForOffer =
      closeSignal && diskSlice && !input.useDemo
        ? pruneStrands(existingStrands).strands
        : null;
    bridgeStrandMergeOffered =
      prunedForOffer !== null &&
      Object.keys(prunedForOffer).length >= MIN_STRANDS_FOR_LLM;
    if (bridgeStrandMergeOffered && prunedForOffer) {
      bridgeStrandMergeNames = new Set(Object.keys(prunedForOffer));
    }
    // Forward the client agent's live tool activity into the turn stream so
    // the user can watch the CLI work during housekeeping — the same
    // data-phase channel + payload the chat bridge model uses
    // (createBridgeEventEmitter), on a distinct id/phase so the two
    // indicators never merge. Frames ride this step's serial stream queue
    // (stream.send), throttled inside the emitter. Deltas ARE forwarded here:
    // for phase "housekeeping" the client suppresses the JSON report block
    // and deltas carry only narration/thinking — they become the indicator's
    // rolling "current activity" line (data.live), so the wait is visible
    // even when the CLI makes zero tool calls. The activity state is folded
    // into the shared card frame (hkActivity) so wrap-up rows (emitStep) and
    // tool/narration frames never overwrite each other — every frame carries
    // the full cumulative state (build-stream: last chunk wins).
    const bridgeActivity = createBridgeEventEmitter({
      id: "phase-bridge-housekeeping",
      phase: "bridgeHousekeeping",
      write: (data: BridgePhaseData) => {
        hkActivity.tools = data.tools;
        hkActivity.live = data.live;
        // The emitter's settle (running:false) fires the moment the bridge
        // call returns, while wrap-up rows (analyze → tags → …) are still
        // being applied — keep the card spinning until they settle too.
        sendHousekeepingCard(
          data.running || hkSteps.some((s) => s.running),
        );
      },
    });
    const bridgeResult = await runHousekeepingBridge(
      {
        userMessage: lastUserMessage,
        recentTurns: input.recentTurns,
        existingStrandNames: Object.keys(existingStrands),
        cardContent: bridgeCardRaw,
        sliceId: diskSlice?.slice_id ?? "pending",
        closingSlice:
          closeSignal && diskSlice
            ? {
                sliceId: diskSlice.slice_id,
                turns: diskSlice.turns,
                tags: diskSlice.tags,
              }
            : undefined,
        drySlices: dryCandidates.length > 0 ? dryCandidates : undefined,
        strandsForMerge:
          bridgeStrandMergeOffered && prunedForOffer
            ? Object.entries(prunedForOffer).map(([name, paths]) => ({
                name,
                slices: paths.length,
              }))
            : undefined,
        signals:
          thisSliceSignals.length > 0 ? thisSliceSignals : undefined,
        directionContent: bridgeDirection,
        selfModelContent: bridgeSelfModel,
        directionMode: bridgeDirectionMode,
        todayLocal:
          localDateKey(input.startedAtIso, input.clientTimezone) ?? undefined,
        locale: input.locale,
      },
      { onEvent: bridgeActivity.onEvent, onDelta: bridgeActivity.onDelta },
    );
    // Settle the indicator (running: false) whatever the outcome.
    bridgeActivity.finish();
    if (bridgeResult.ok) {
      bridgeReport = bridgeResult.report;
      analysis = adaptHousekeepingReport(
        bridgeResult.report,
        !!(closeSignal && diskSlice),
      );
    } else {
      console.warn(
        `[HousekeepingBridge] ${bridgeResult.reason} — degraded to the deterministic path`,
      );
      analysis = degradedAnalysis();
      // Surface the degradation on the card — it must not settle silently
      // green when the memory analysis fell back to heuristics.
      hkActivity.warning = bridgeResult.reason;
      sendHousekeepingCard(hkSteps.some((s) => s.running));
    }
  } else {
    // Task 7's scoring rubric (v1.1): the direction doc's PORTRAIT section —
    // the loop's learned criteria — rides the analyzer's USER prompt (never
    // the static system prompt), capped. Advisory: a read failure just means
    // scoring without the rubric this turn. (The bridge path's report already
    // scores against the full direction doc shipped in its payload.)
    let portrait: string | undefined;
    if (!input.useDemo) {
      try {
        const directionDoc = await readDirection();
        const section = directionDoc
          ? extractDirectionSection(directionDoc, "# Portrait")
          : null;
        // Skip the untouched template's "_(" placeholder body.
        if (section && !section.trimStart().startsWith("_(")) {
          portrait = section.slice(0, ANALYZER_PORTRAIT_MAX_CHARS);
        }
      } catch {
        // rubric unavailable — score without it
      }
    }
    analysis = await analyzeTurn({
      model: input.modelConfig,
      userMessage: lastUserMessage,
      existingStrandNames: Object.keys(existingStrands),
      closingSlice:
        closeSignal && diskSlice
          ? { turns: diskSlice.turns, tags: diskSlice.tags }
          : undefined,
      signals: thisSliceSignals.length > 0 ? thisSliceSignals : undefined,
      portrait,
    });
  }
  const candidateTags = analysis.memoryWorthy
    ? [
        ...analysis.messageTags.reuse,
        ...analysis.messageTags.create.map((c) => c.tag),
      ]
    : [];
  await emitStep(
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
    await emitStep("slice-closed", false, [diskSlice.slice_id]);
    // v0.8 — force the reconcile so the just-closed slice is in the projection
    // immediately (the throttled per-turn weave would defer it up to 5 min).
    await weaveTimeline({ force: true }, batch);

    // Strand consolidation (opportunistic, on slice close): prune single-use
    // stale strands deterministically; when the index is large enough, ask the
    // model (main model via the shared runner, v0.9) for a from→to merge map
    // to collapse semantic duplicates
    // (typos / same-concept-two-names) that deterministic normalization can't
    // catch. Writes land in the current batch → one commit with the close.
    // Phase outsourcing (bridge brain): the merge proposals arrived INSIDE the
    // single housekeeping bridge call (report.strand_merges, job 5) — the
    // deterministic prune still runs here, then the proposed merges are
    // sanitized exactly like the consolidator's own output (both keys must
    // exist post-prune, no no-ops) and applied through the same
    // applyStrandMerges. Honors merges only when candidates were offered.
    const strandsBefore = await readStrands(batch);
    const { strands: consolidated, pruned, merges, llmPassSkipped } =
      phaseOutsource
        ? (() => {
            const { strands, pruned } = pruneStrands(strandsBefore);
            const proposed = bridgeStrandMergeOffered
              ? (bridgeReport?.strand_merges ?? [])
              : [];
            // Sanitize exactly like the consolidator's own output (no no-ops,
            // both keys must exist post-prune) AND honor the offer allowlist
            // (both keys must have been offered — same discipline as the
            // backfill candidate ids).
            const merges = proposed.filter(
              (m) =>
                m.from !== m.to &&
                bridgeStrandMergeNames?.has(m.from) === true &&
                bridgeStrandMergeNames?.has(m.to) === true &&
                strands[m.from] !== undefined &&
                strands[m.to] !== undefined,
            );
            if (merges.length > 0) applyStrandMerges(strands, merges);
            return { strands, pruned, merges, llmPassSkipped: !bridgeStrandMergeOffered };
          })()
        : await consolidateStrands(strandsBefore, input.modelConfig);
    if (pruned.length > 0 || merges.length > 0) {
      await fsWriteFile(getStrandsPath(), serializeStrands(consolidated), batch);
      console.log(
        `[Strands] Consolidation: pruned ${pruned.length}, merged ${merges.length}` +
        (llmPassSkipped ? " (llm skipped)" : ""),
      );
    }

    // Checkpoint continuation link: only time_cap/capacity closes are
    // autosave checkpoints of the SAME conversation — the new slice carries
    // the closed slice's tail as live context. idle_gap/context_lost are
    // genuine conversation boundaries and get no link (no carry-over).
    const checkpoint =
      closeSignal === "time_cap" || closeSignal === "capacity";
    slice = createSlice(
      lastUserMessage,
      clientTimezone,
      input.turnId,
      checkpoint ? diskSlice.slice_id : undefined,
    );
    createdNewSlice = true;
  } else if (diskSlice && diskSlice.status === "active") {
    slice = diskSlice;
    console.log(`[Episodic] Restored active slice: ${diskSlice.slice_id} (${diskSlice.turns.length} turns)`);
  } else {
    slice = createSlice(lastUserMessage, clientTimezone, input.turnId);
    createdNewSlice = true;
    console.log(`[Episodic] Created new slice: ${slice.slice_id}`);
  }

  // ── 3a. Fitness events (v1.0 §2.5) — persist the analyzer's deltas ──────
  // The analyzer SCORES (single evidence-anchored deltas), the store aggregates.
  // Both paths land here: the direct analyzer's analysis.fitness and the bridge
  // report's fitness array (mapped onto the same shape by
  // adaptHousekeepingReport). An analyzer/bridge failure carries no fitness
  // field → nothing is appended. The events are attributed to the slice they
  // were scored on — the CLOSED slice on a boundary, else the active one. The
  // store's evidence force-zero is the structural backstop, not duplicated.
  if (analysis.fitness && analysis.fitness.length > 0) {
    try {
      const scoredSliceId =
        closeSignal && diskSlice ? diskSlice.slice_id : slice.slice_id;
      const ts = new Date().toISOString();
      await appendFitnessEvents(
        analysis.fitness.map((f) => ({
          ts,
          sliceId: scoredSliceId,
          bucket: f.bucket,
          delta: f.delta,
          evidence: f.evidence,
        })),
        batch,
      );
    } catch (e) {
      // Scoring is instrumentation — a store failure must never take a turn down.
      console.warn(
        "[Evolution] fitness event append failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ── 3b. Dry-slice backfill (opportunistic, only on a close boundary) ────
  // Slices that closed dry (needs_marking) never got their semantics rewritten
  // — pick up to 3 from the catalog and mark them from their core.md (main
  // model via the shared runner, v0.9), inside this turn's batch. Best-effort:
  // failures skip silently, the active slice is never touched, and demo mode
  // is skipped entirely (its writes are no-ops — no reason to spend the calls).
  // Phase outsourcing (bridge brain): the marks arrived INSIDE the single
  // housekeeping bridge call (report.backfill_marks) — no extra CLI spawns.
  // Only candidate ids we actually offered are honored, and the same
  // frontmatter/catalog write path (applyMarksToDrySlices) applies them.
  if (closeSignal && diskSlice && !input.useDemo) {
    if (phaseOutsource) {
      const allowed = new Set(bridgeDryCandidateIds);
      const marks = (bridgeReport?.backfill_marks ?? [])
        .map((m) => ({
          id: m.slice_id,
          focus: m.focus.trim(),
          summary: m.summary.trim(),
        }))
        .filter((m) => allowed.has(m.id) && (m.focus || m.summary));
      try {
        const marked = await applyMarksToDrySlices(marks, batch);
        if (marked > 0) {
          console.log(
            `[Timeline] backfilled marks for ${marked} dry slice(s) (bridge report)`,
          );
        }
      } catch {
        // best-effort — never take a turn down
      }
    } else {
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
  }

  // ── 4. Apply the current message's tags to the active slice ──────────
  // Merge-first at the slice boundary too: `reuse` tags must resolve to an
  // existing strand (a hallucinated name is dropped, never minted); `create`
  // tags are folded into an existing strand via normalized-match before a new
  // key is ever allowed. This keeps a slice's accumulated tags from inventing
  // near-duplicate strands mid-slice (they'd otherwise hit strands.json before
  // the close-time cleaning replaces them).
  // Phase: tags — the analyzer (above) found them; this step applies them.
  await emitStep("tags", true);
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
  await emitStep("tags", false, appliedTags);

  // ── 5. Append user turn ───────────────────────────────────────────────
  // Dedup by turnId (user and agent turns of a round share it — scope the
  // check to role): a redelivered workflow run finds its user turn already
  // persisted and skips the append. Legacy turns parsed from old files carry
  // no turnId, so the content check below stays as the fallback (mirrors the
  // turnKey fallback in lib/episodic/turn-merge.ts).
  // A regenerate turn never appends: the question is already the slice's last
  // user turn — the rejected reply stays, the new answer joins as a second
  // agent turn under the fresh turnId.
  const isNewSlice =
    slice.turns.length === 1 && slice.turns[0].content === lastUserMessage;
  const userTurnRecorded =
    !!input.turnId &&
    slice.turns.some((t) => t.role === "user" && t.turnId === input.turnId);
  if (!isNewSlice && !userTurnRecorded && !input.regenerate) {
    appendTurn(slice, {
      timestamp: new Date().toISOString(),
      role: "user",
      content: lastUserMessage,
      turnId: input.turnId,
    });
  }
  // The regenerate signal is a fact about the user's reaction, recorded in
  // the slice that will hold the re-answer (the next turn's analyzer picks it
  // up as an interaction-bucket candidate — design §2.6).
  if (input.regenerate) {
    await logInteractionSignal(
      "interaction_regenerate",
      slice.slice_id,
      "user regenerated the previous reply — the answer was rejected",
      batch,
    );
  }
  await emitStep("slice", false, [slice.slice_id]);

  // ── Phase: context — load the user profile (previously + identity) ───
  await emitStep("context", true);

  // ── 4b. Card evolution (v0.7b / v5, mutation-based) ─────────────────────
  // ONE pass, owned by the Previously Agent. Engineering owns the TRIGGER
  // only; every content decision (expiry, overdue handling, caps, format)
  // belongs to the agent, enforced INSIDE its write tools — there is no
  // mechanical pass that silently edits the card.
  // v1.1: the trigger check runs EVERY turn, BEFORE the agent reply (the
  // owner's model: when negative feedback is identified, the evolution check
  // must fire — the reply the user is about to read should already reflect
  // it). The check is a deterministic fitness-trigger computation
  // (computeEvolutionTriggers) combined with the card bucket's legacy gates
  // and the direction bootstrap/migrate gate; a fired check runs the MERGED
  // self-evolution agent ONCE (max one run per turn — a boundary turn never
  // also takes the mid-turn path): it evaluates direction.md FIRST (its
  // proposal is validated + applied inside runCardEvolution through the old
  // Phase-1 write paths) and evolves the card + triggered-bucket playbooks
  // under the possibly-new direction.
  // Accepted mutations are archived with their expected benefit (design §2.7)
  // inside runCardEvolution.
  //
  // GENERATION SEMANTICS (v0.9.2): the fitness store holds only the CURRENT
  // generation's selection pressure. A bucket fires when its generation net
  // reaches EVOLVE_TRIGGER_THRESHOLD (-5) — purely quantitative, no semantic
  // fast paths. A SUCCESSFUL fitness-triggered run SETTLES the generation
  // (resetFitnessGeneration clears every bucket's events + signals — even a
  // "checked, no change" verdict counts: the judge read the docket): the
  // outcome already sedimented into card/direction/playbooks, so the spent
  // pressure is discarded and re-accumulates from zero. A FAILED run settles
  // nothing (the pressure stays and retries next turn). Runs gated by the
  // boundary/direction/explicit channels WITHOUT a fitness trigger never saw
  // the pressure's evidence, so they do not settle it.
  // Gates:
  //   (a) fitness triggers — a bucket whose generation net dropped to the
  //       threshold (every turn, boundary or not);
  //   (b) slice boundary — gated by the ANALYZER's judgment (evolveCard.worth);
  //       on analyzer failure the gate defaults to running (a wasted worker
  //       call is cheap, a missed evolution is permanent memory loss). A
  //       LEGACY (pre-v5) card FORCES a run so format migration never waits
  //       for a "worthy" boundary. When skipped, a terminal data-evolution
  //       chunk (status "done") is still emitted so the skip stays visible
  //       (with the reason).
  //   (c) the user explicitly asking to record/evolve, or stating an explicit
  //       behavioral correction (analyzeTurn's memoryUpdate) — the
  //       INSTRUCTION channel, not selection pressure;
  //   (d) the direction bootstrap/migrate gate (v1.1) — the FIRST direction
  //       must not wait for a complaint, an OLD-skeleton doc not for a
  //       boundary.
  // Boundary-only work (strand consolidation, dry-slice backfill, the deep
  // whole-slice review) stays boundary-only.
  // The run is INLINE (blocking) so the reply reads the freshly-evolved card.
  // Progress streams to the client; the result's summary
  // is frozen into the new slice's frontmatter (evolution_summary) so the L3
  // slice-head block can replay it on every turn of the slice.
  // Demo mode is skipped entirely — it is a read-only preview and must never
  // write the real card (the old /api/evolution route also returned skipped).
  //
  // The deterministic trigger check: computed over the store AFTER §3a
  // appended this turn's fresh deltas (batch read-your-writes). No trigger,
  // no gate → NO evolution run.
  const fitnessStore = input.useDemo
    ? emptyFitnessStore()
    : await readFitness(batch);
  const evolutionTriggers = input.useDemo
    ? []
    : computeEvolutionTriggers(fitnessStore);
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
  let evolutionStep: "direction" | "reading" | "reviewing" = "reading";
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
  /**
   * Apply the bridge report's direction verdict (v1.0 §6) through the SAME
   * write paths as the merged run — structural validation identical to the
   * direction sub-agent flow (validateDirectionProposal), then writeDirection
   * + the mutations archive (target "direction"). Shared by the boundary and
   * mid-turn bridge paths. Returns the outcome for the terminal frame; a
   * failed/rejected write returns UNDEFINED (a failure must not masquerade as
   * "no_change") and surfaces as an amber warning row on the housekeeping
   * card, never a silent skip.
   */
  const applyBridgeDirectionVerdict = async (): Promise<
    EvolutionResult["direction"]
  > => {
    if (!bridgeReport || !bridgeReport.direction) return undefined;
    if (bridgeReport.direction === "no_change") return { outcome: "no_change" };
    const proposed = bridgeReport.direction;
    const validation = validateDirectionProposal(
      proposed.proposed,
      bridgeDirection,
      { mode: bridgeDirectionMode },
    );
    if (!validation.ok) {
      hkActivity.warning = `Direction proposal rejected: ${validation.reason}`;
      sendHousekeepingCard(false);
      return undefined;
    }
    try {
      await writeDirection(proposed.proposed.trim(), batch);
      const summary =
        proposed.summary.trim() || "Direction updated (bridge housekeeping report)";
      await appendMutation(
        {
          ts: new Date().toISOString(),
          target: "direction",
          summary,
          evidence: proposed.evidence,
          expectedBenefit: proposed.expected_benefit.trim() || "(none given)",
        },
        batch,
      );
      console.log("[Evolution] direction updated (bridge report)");
      return { outcome: "updated", summary };
    } catch (e) {
      hkActivity.warning = `Direction write failed: ${e instanceof Error ? e.message : e}`;
      sendHousekeepingCard(false);
      return undefined;
    }
  };
  /**
   * Settle the fitness generation after a SUCCESSFUL fitness-triggered
   * evolution run (v0.9.2 — see the §4b header). Only a run that fired
   * BECAUSE of selection pressure (evolutionTriggers non-empty) and
   * completed without an error settles the store — a "checked, no change"
   * verdict included (the judge read the docket). A failed run leaves the
   * pressure in place so the next turn retries. Best-effort: a reset
   * failure just means the pressure lingers until the next run.
   */
  const settleFitnessGeneration = async (result: {
    ran: boolean;
    error?: string;
  }) => {
    if (evolutionTriggers.length === 0 || !result.ran || result.error) return;
    try {
      await resetFitnessGeneration(batch);
      console.log(
        `[Evolution] generation settled (triggers: ${evolutionTriggers.map((t) => t.bucket).join(", ")})`,
      );
    } catch (e) {
      console.warn(
        "[Evolution] generation reset failed:",
        e instanceof Error ? e.message : e,
      );
    }
  };
  try {
    if (!input.useDemo && closeSignal && diskSlice) {
      // Read-only fact for the trigger. In the outsourced path the card was
      // already read for the bridge payload (analyze stage) — reuse it.
      const cardRaw = bridgeCardRaw ?? (await readCurrentPreviously(batch));
      // A legacy (pre-v5) card forces the run — migration must not wait for a
      // "worthy" boundary.
      const legacyCard =
        cardRaw.trim().length > 0 && !cardRaw.includes(CARD_STAMP);
      // The card's legacy Self-model lines = the direction half's MIGRATION
      // source (folded into the Portrait, then dropped from the card). Null
      // when the card has none.
      const cardDoc = parseCard(cardRaw);
      const cardSelfModel =
        cardDoc && cardDoc.selfModel.length > 0
          ? cardDoc.selfModel.map((s) => `- ${s}`).join("\n")
          : null;

      if (phaseOutsource) {
        // Bridge path: the evolution decision + mutation proposals arrived in
        // the SAME bridge call as the analysis — apply them through the
        // card-session machinery (applyBridgeCardEvolution), no second spawn.
        //
        // Phase-1 verdict first (v1.0 §6): the outsourced call's direction
        // outcome rides the same report and is applied through the SAME write
        // paths as the direction sub-agent flow (applyBridgeDirectionVerdict).
        const bridgeDirectionOutcome = await applyBridgeDirectionVerdict();
        // The verdict rides every terminal frame of this branch.
        const withDirection = (
          result: EvolutionResult,
        ): EvolutionResult => ({
          ...result,
          ...(bridgeDirectionOutcome
            ? { direction: bridgeDirectionOutcome }
            : {}),
        });

        if (!bridgeReport) {
          await emitEvolutionResult(stream, {
            ran: false,
            changed: false,
            droppedRecent: 0,
            note: "Housekeeping bridge unavailable — card evolution skipped this turn.",
            error: "housekeeping bridge failed",
          });
        } else if (
          (bridgeReport.evolution.worth || legacyCard) &&
          bridgeReport.evolution.mutations.length > 0
        ) {
          // The card opens in its running state first — a terminal chunk out
          // of nowhere reads as "it never ran".
          emitEvolutionProgress(stream, "reviewing");
          evolutionResult = await applyBridgeCardEvolution({
            card: cardRaw,
            sliceId: diskSlice.slice_id,
            today: todayLocal ?? new Date().toISOString().slice(0, 10),
            reason: bridgeReport.evolution.reason,
            mutations: bridgeReport.evolution.mutations,
            batch,
          });
          await settleFitnessGeneration(evolutionResult);
          await emitEvolutionResult(stream, withDirection(evolutionResult));
          freezeEvolutionSummary(slice);
          console.log(
            `[Evolution] bridge slice-close: changed=${evolutionResult.changed}${legacyCard ? " (legacy card migration)" : ""}`,
          );
        } else {
          // Report-judged skip — the terminal chunk keeps the skip visible.
          await emitEvolutionResult(
            stream,
            withDirection({
              ran: false,
              changed: false,
              droppedRecent: 0,
              note: `Slice boundary — nothing worth sedimenting (${bridgeReport.evolution.reason || "no reason given"}).`,
            }),
          );
        }
      } else {
        // ── v1.1 merged evolution run
        // The deterministic trigger check already ran for this turn (above):
        // per-bucket CURRENT-GENERATION net scores (computeEvolutionTriggers),
        // combined here with the card bucket's legacy gates (analyzer worth /
        // legacy-card force) and the direction bootstrap/migrate gate below.
        // Nothing due → NO evolution agent runs — the mandatory per-turn
        // check IS this code-level scoring (mandatory check ≠ mandatory
        // mutation).
        const triggers = evolutionTriggers;
        // The terminal frame's "why it ran" rows (v1.0 §2.5): each fired
        // bucket with its current generation net score. Empty when the run was
        // gated by the analyzer / a legacy card instead — the card then shows
        // no score rows.
        const triggerRows: NonNullable<EvolutionResult["triggers"]> =
          triggers.map((t) => ({
            bucket: t.bucket,
            score: bucketNetScore(fitnessStore, t.bucket),
          }));
        const cardGate = shouldRunCardEvolution(analysis) || legacyCard;

        // Direction gate (v1.1): the FIRST direction must not wait for a
        // complaint, and an OLD-skeleton doc must not wait to be re-shaped.
        // BOOTSTRAP (template/unset) is due when material is at hand (legacy
        // Self-model lines on the card, or any fitness events); MIGRATE (the
        // old # Direction / # Anti-goals skeleton) is always due — the
        // existing doc IS the material. The gate dies permanently once the doc
        // lands in the new skeleton.
        //
        // Per-slice backoff: a proposal REJECTED by validation leaves the old
        // skeleton in place, so the gate would re-fire the full merged run on
        // every remaining turn of this slice — a rejected slice id (recorded
        // below, keyed to the ACTIVE slice) silences the gate for the rest of
        // the slice. The next slice is not on the list and retries fresh.
        await ensureEvolutionFiles();
        const currentDirection = await readDirection();
        const directionMode = detectDirectionMode(currentDirection);
        const directionBackedOff = fitnessStore.directionRejections.includes(
          slice.slice_id,
        );
        const directionDue =
          !directionBackedOff &&
          (directionMode === "migrate" ||
            (directionMode === "bootstrap" &&
              (cardSelfModel !== null || fitnessStore.events.length > 0)));

        if (triggers.length > 0 || cardGate || directionDue) {
          // ONE merged run: the agent evaluates direction.md FIRST (the
          // proposal is validated mode-aware + applied inside runCardEvolution
          // through the old Phase-1 write paths), then evolves the card (+
          // triggered-bucket playbooks) under the possibly-new direction. The
          // direction verdict arrives on the result and rides the terminal
          // frame — including failures (a silent failure reads as "it never
          // runs"). The progress card opens on the "direction" step; the run's
          // own onProgress moves it to "reviewing".
          evolutionStep = "direction";
          emitEvolutionProgress(stream, "direction");
          // The episodic trail the portrait calibrates against — the catalog
          // already carries focus/summary/tone, one read for the window. The
          // just-closed slice is excluded: its marking already rides
          // `analysis.closedMarking`.
          const markingIndex = await readTimelineIndex().catch(() => null);
          const recentMarkings = (markingIndex?.slices ?? [])
            .filter(
              (s) => s.status === "closed" && s.id !== diskSlice.slice_id,
            )
            .slice(-DIRECTION_RECENT_MARKINGS)
            .reverse()
            .map((s) => ({
              id: s.id,
              focus: s.focus,
              summary: s.summary,
              tone: s.tone,
            }));
          const triggeredBuckets = triggers.map((t) => t.bucket);
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
          directionEval: {
            current: currentDirection,
            mode: directionMode,
            cardSelfModel,
            recentEvents: fitnessStore.events.slice(-DIRECTION_RECENT_EVENTS),
            recentMarkings,
            analysis,
          },
          triggeredBuckets,
          fitnessEvents: fitnessStore.events
            .filter((e) => triggeredBuckets.includes(e.bucket))
            .slice(-15),
          fitnessSignals: thisSliceSignals,
        });
          // A REJECTED direction proposal (the old skeleton survives) must not
          // re-fire the gate on every remaining turn of this slice — record
          // the backoff keyed to the ACTIVE slice. Best-effort: a recording
          // failure just means the gate fires once more next turn.
          if (evolutionResult.direction?.outcome === "rejected") {
            await recordDirectionRejection(slice.slice_id, batch).catch((e) =>
              console.warn(
                "[Evolution] could not record the direction rejection:",
                e instanceof Error ? e.message : e,
              ),
            );
          }
          // A successful fitness-triggered run settles the generation (the
          // spent pressure is discarded; a failed run settles nothing).
          await settleFitnessGeneration(evolutionResult);
          // Fold the "why it ran" calibration rows into the terminal frame —
          // for BOTH the changed and the checked-no-updates outcomes. (The
          // direction verdict already rides the result from runCardEvolution.)
          evolutionResult = {
            ...evolutionResult,
            ...(triggerRows.length > 0 ? { triggers: triggerRows } : {}),
          };
          await emitEvolutionResult(stream, evolutionResult);
          freezeEvolutionSummary(slice);
          console.log(
            `[Evolution] inline slice-close: changed=${evolutionResult.changed}` +
              (triggers.length > 0
                ? ` (triggers: ${triggers.map((t) => t.bucket).join(", ")})`
                : "") +
              (directionDue ? ` (direction ${directionMode})` : "") +
              (legacyCard ? " (legacy card migration)" : ""),
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
      }
    } else if (!input.useDemo && slice) {
      // ── Mid-turn evolution check (every turn, BEFORE the reply) ──
      // The trigger math ran above over this turn's fresh deltas; the
      // legacy-card force and the direction bootstrap/migrate gate apply here
      // too. A fired check runs the ONE merged evolution NOW. A boundary turn
      // never reaches this branch (handled above) — one run per turn max.
      await ensureEvolutionFiles();
      const currentDirection = await readDirection();
      const directionMode = detectDirectionMode(currentDirection);
      // The card is read only when a gate/run needs it (bootstrap material /
      // the legacy force / the run's Self-model migration source).
      let cardSelfModel: string | null = null;
      let legacyCard = false;
      if (directionMode === "bootstrap" || evolutionTriggers.length > 0) {
        const cardRaw = bridgeCardRaw ?? (await readCurrentPreviously(batch));
        legacyCard = cardRaw.trim().length > 0 && !cardRaw.includes(CARD_STAMP);
        const cardDoc = parseCard(cardRaw);
        cardSelfModel =
          cardDoc && cardDoc.selfModel.length > 0
            ? cardDoc.selfModel.map((s) => `- ${s}`).join("\n")
            : null;
      }
      // Same discipline as the boundary gate: MIGRATE is always due;
      // BOOTSTRAP is due with material at hand (legacy Self-model lines on
      // the card, or any fitness events). `directionDue` stays RAW (backoff
      // NOT applied) for mergedGate: the bridge path below applies verdicts
      // its one housekeeping call already produced, so a rejected direction
      // must not suppress an otherwise-worthy card mutation there. The backoff
      // only gates the INLINE run — the one that costs a full merged
      // Previously Agent call per turn.
      const directionBackedOff = fitnessStore.directionRejections.includes(
        slice.slice_id,
      );
      const directionDue =
        directionMode === "migrate" ||
        (directionMode === "bootstrap" &&
          (cardSelfModel !== null || fitnessStore.events.length > 0));
      const mergedGate =
        evolutionTriggers.length > 0 || directionDue || legacyCard;
      // The terminal frame's "why it ran" rows — same as the boundary path.
      const triggerRows: NonNullable<EvolutionResult["triggers"]> =
        evolutionTriggers.map((t) => ({
          bucket: t.bucket,
          score: bucketNetScore(fitnessStore, t.bucket),
        }));

      if (mergedGate) {
        if (phaseOutsource) {
          // Bridge path: this turn's ONE bridge call already folded the
          // evolution decision into its report (its fitness deltas feed the
          // trigger check above after being applied in §3a) — apply the
          // verdict + proposed mutations through the same write paths, no
          // second spawn.
          const bridgeDirectionOutcome = await applyBridgeDirectionVerdict();
          const withDirection = (
            result: EvolutionResult,
          ): EvolutionResult => ({
            ...result,
            ...(bridgeDirectionOutcome
              ? { direction: bridgeDirectionOutcome }
              : {}),
          });
          if (bridgeReport && bridgeReport.evolution.mutations.length > 0) {
            // Open the card in its running state first — a terminal chunk out
            // of nowhere reads as "it never ran".
            emitEvolutionProgress(stream, "reviewing");
            evolutionResult = await applyBridgeCardEvolution({
              card: bridgeCardRaw ?? (await readCurrentPreviously(batch)),
              sliceId: slice.slice_id,
              today: todayLocal ?? new Date().toISOString().slice(0, 10),
              reason:
                bridgeReport.evolution.reason ||
                `Fitness trigger: ${evolutionTriggers.map((t) => t.bucket).join(", ")}`,
              mutations: bridgeReport.evolution.mutations,
              batch,
            });
            await settleFitnessGeneration(evolutionResult);
            await emitEvolutionResult(stream, withDirection({
              ...evolutionResult,
              ...(triggerRows.length > 0 ? { triggers: triggerRows } : {}),
            }));
            freezeEvolutionSummary(slice);
            console.log(
              `[Evolution] bridge mid-turn: changed=${evolutionResult.changed}` +
                (evolutionTriggers.length > 0
                  ? ` (triggers: ${evolutionTriggers.map((t) => t.bucket).join(", ")})`
                  : "") +
                (directionDue ? ` (direction ${directionMode})` : ""),
            );
          } else {
            await emitEvolutionResult(
              stream,
              withDirection({
                ran: false,
                changed: false,
                droppedRecent: 0,
                note: bridgeReport
                  ? `Evolution check fired — no card mutation proposed (${bridgeReport.evolution.reason || "no reason given"}).`
                  : "Housekeeping bridge unavailable — card evolution skipped this turn.",
                ...(bridgeReport ? {} : { error: "housekeeping bridge failed" }),
                ...(triggerRows.length > 0 ? { triggers: triggerRows } : {}),
              }),
            );
          }
        } else if (
          evolutionTriggers.length > 0 ||
          legacyCard ||
          (directionDue && !directionBackedOff)
        ) {
          // ONE merged run, light mode (no deep whole-slice review — that
          // stays boundary-scoped): the agent evaluates direction.md FIRST,
          // then evolves the card (+ triggered-bucket playbooks) under the
          // possibly-new direction.
          evolutionStep = "direction";
          emitEvolutionProgress(stream, "direction");
          const markingIndex = await readTimelineIndex().catch(() => null);
          const recentMarkings = (markingIndex?.slices ?? [])
            .filter((s) => s.status === "closed" && s.id !== slice.slice_id)
            .slice(-DIRECTION_RECENT_MARKINGS)
            .reverse()
            .map((s) => ({
              id: s.id,
              focus: s.focus,
              summary: s.summary,
              tone: s.tone,
            }));
          const triggeredBuckets = evolutionTriggers.map((t) => t.bucket);
          evolutionResult = await runCardEvolution({
            model: input.modelConfig,
            sliceId: slice.slice_id,
            recentTurns: input.recentTurns,
            currentSliceTags: slice.tags,
            signal: "new_observation",
            focus: explicitUpdate?.content,
            readers: buildCardReaders(input),
            onProgress: onEvolutionProgress,
            onEvolutionLine,
            batch,
            todayDate: todayLocal,
            directionEval: {
              current: currentDirection,
              mode: directionMode,
              cardSelfModel,
              recentEvents: fitnessStore.events.slice(-DIRECTION_RECENT_EVENTS),
              recentMarkings,
              analysis,
            },
            triggeredBuckets,
            fitnessEvents: fitnessStore.events
              .filter((e) => triggeredBuckets.includes(e.bucket))
              .slice(-15),
            fitnessSignals: thisSliceSignals,
          });
          // Same per-slice backoff as the boundary path: a rejected direction
          // proposal silences the gate for the rest of THIS slice.
          if (evolutionResult.direction?.outcome === "rejected") {
            await recordDirectionRejection(slice.slice_id, batch).catch((e) =>
              console.warn(
                "[Evolution] could not record the direction rejection:",
                e instanceof Error ? e.message : e,
              ),
            );
          }
          await settleFitnessGeneration(evolutionResult);
          evolutionResult = {
            ...evolutionResult,
            ...(triggerRows.length > 0 ? { triggers: triggerRows } : {}),
          };
          await emitEvolutionResult(stream, evolutionResult);
          freezeEvolutionSummary(slice);
          console.log(
            `[Evolution] mid-turn check: changed=${evolutionResult.changed}` +
              (evolutionTriggers.length > 0
                ? ` (triggers: ${evolutionTriggers.map((t) => t.bucket).join(", ")})`
                : "") +
              (directionDue ? ` (direction ${directionMode})` : "") +
              (legacyCard ? " (legacy card migration)" : ""),
          );
        } else {
          // Only the direction gate fired and it is BACKED OFF for this slice
          // (a proposal was already rejected) — skip visibly rather than
          // re-running the full merged evolution on every remaining turn.
          await emitEvolutionResult(stream, {
            ran: false,
            changed: false,
            droppedRecent: 0,
            note: `Direction ${directionMode} gate backed off for this slice — a proposal was already rejected; the next slice retries.`,
          });
        }
      } else if (explicitUpdate) {
      if (phaseOutsource) {
        const cardRaw = bridgeCardRaw ?? (await readCurrentPreviously(batch));
        if (bridgeReport && bridgeReport.evolution.mutations.length > 0) {
          // Open the card in its running state before applying — see the
          // slice-close branch above.
          emitEvolutionProgress(stream, "reviewing");
          evolutionResult = await applyBridgeCardEvolution({
            card: cardRaw,
            sliceId: slice.slice_id,
            today: todayLocal ?? new Date().toISOString().slice(0, 10),
            reason: bridgeReport.evolution.reason || explicitUpdate.content,
            mutations: bridgeReport.evolution.mutations,
            batch,
          });
          await emitEvolutionResult(stream, evolutionResult);
          freezeEvolutionSummary(slice);
          console.log(
            `[Evolution] bridge user request: changed=${evolutionResult.changed}`,
          );
        } else {
          await emitEvolutionResult(stream, {
            ran: false,
            changed: false,
            droppedRecent: 0,
            note: bridgeReport
              ? `Memory update noted — no card mutation proposed (${bridgeReport.evolution.reason || "no reason given"}).`
              : "Housekeeping bridge unavailable — card evolution skipped this turn.",
            ...(bridgeReport ? {} : { error: "housekeeping bridge failed" }),
          });
        }
      } else {
        // v1.0: the direction doc is orientation for the product phase even on
        // an explicit-request run (no direction evaluation and no fitness
        // buckets triggered here, so writePlaybook stays gated off).
        const direction = await readDirection().catch(() => null);
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
          direction,
          triggeredBuckets: [],
        });
        await emitEvolutionResult(stream, evolutionResult);
        freezeEvolutionSummary(slice);
        console.log(
          `[Evolution] inline user request: changed=${evolutionResult.changed}`,
        );
      }
      }
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
  await emitStep("strands", true);
  const strands = await readStrands();
  // Anchored to the SLICE START (not "now") so the relative-day annotations
  // stay byte-stable for the slice's whole life (v0.9 prefix-cache freeze).
  const strandsMenu = buildStrandsMenu(strands, {
    nowIso: slice.start,
    timezone: input.clientTimezone,
    locale: input.locale,
  });
  await emitStep("strands", false, [`${Object.keys(strands).length} strands`]);

  // ── 6b. Continuity + slice-head snapshot + identity ──────────────────
  // v0.9 slice-level prompt freeze: the continuity stance is computed at the
  // SLICE'S BIRTH, not per turn — the reference is the newest slice closed
  // before this one began (a slice we closed this call, else the catalog),
  // and the gap is measured against `slice.start`. Recomputed this way on
  // every turn, the resulting line is byte-identical for the slice's life.
  if (!prevSlice) {
    prevSlice = await readMostRecentClosedSlice(slice.slice_id);
  }
  const continuity = classifyContinuity(
    slice.start,
    prevSlice,
    false,
    slice.continuesFrom,
  );

  // ── Checkpoint carry-over — a slice born from a time_cap/capacity close
  // continues the SAME conversation: the previous slice's frozen tail is
  // prepended to the history window (turn-workflow) so the dialogue flows
  // seamlessly across the checkpoint. The tail is read server-side from the
  // CLOSED slice (never from client messages), so it is byte-fixed for this
  // slice's whole life and the window stays append-only. Best-effort: an
  // unreadable predecessor just means no carry-over. Role-alternation safety
  // (orphan user tail after a stop/cancel, double agent turns after a
  // regenerate) is enforced where the prefix joins the window —
  // sanitizeCheckpointPrefix in turn-workflow.ts.
  let contextPrefix: ModelMessage[] | undefined;
  if (slice.continuesFrom) {
    const prevTurns =
      closeSignal && diskSlice && diskSlice.slice_id === slice.continuesFrom
        ? diskSlice.turns // just closed in this call — already in memory
        : (await loadSlice(slice.continuesFrom, batch))?.turns;
    const tail = prevTurns?.slice(-CHECKPOINT_CARRY_OVER_TURNS) ?? [];
    if (tail.length > 0) {
      contextPrefix = tail.map(
        (t): ModelMessage => ({
          role: t.role === "agent" ? "assistant" : "user",
          content: t.content,
        }),
      );
    }
  }

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

  // The direction layer for the main agent's system prompt (v1.1): read per
  // turn like the card, AFTER the batch flush — so a direction an evolution
  // run just landed THIS turn (the slice boundary or the mid-turn merged run
  // above) is read back fresh and already shapes THIS turn's reply, not only
  // the next one. That makes the system prompt drift mid-slice on exactly
  // those turns — a deliberate trade: on the rare turn the direction actually
  // moves, freshness beats the prefix-cache hit.
  // Missing / template / legacy-skeleton docs omit the layer entirely
  // (buildDirectionBlock returns "").
  const directionBlock = buildDirectionBlock(
    await readDirection().catch(() => null),
  );

  await emitStep("context", false, [`continuity: ${continuity.tier}`]);

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
    ...(directionBlock ? { directionBlock } : {}),
    ...(timelineBrief ? { timelineBrief } : {}),
    ...(contextPrefix ? { contextPrefix } : {}),
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
