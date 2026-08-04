/**
 * Tool executors for the shared WorkflowAgent �?standalone "use step" functions.
 *
 * Each executor is an independent durable step: automatically retried on
 * failure, persisted, and visible in the workflow dashboard. Context (repo,
 * owner, useGithub, sliceId / loop identity) flows through WorkflowAgent's
 * `toolsContext` mechanism rather than JavaScript closures, so it stays
 * serializable across workflow/step boundaries.
 *
 * Used by BOTH the chat turn workflow and the background loop workflow �?the
 * tool definitions that bind these executors live in ./tools.ts.
 */

import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import crypto from "crypto";
// Side effect: register the DeepSeek model class in the step runtime's
// serialization registry (see register-model-classes.ts for why).
import "./register-model-classes";
import { startThink } from "@/app/api/thinking/start-think";
import { appendThinkingAgent } from "@/lib/sessions/store";
import { writeTaskCard } from "@/lib/thinking/store";
import type { ThinkInput } from "@/lib/thinking/types";
import { readFile } from "@/lib/tools/readFile";
import { listFiles } from "@/lib/tools/listFiles";
import {
  readFileLocal,
  listFilesLocal,
} from "@/lib/tools/local-fs";
import {
  readFileDemo,
  listFilesDemo,
} from "@/lib/demo/demo-fs";

import { searchViaFlash, type WebSearchResult } from "@/lib/search/flash-search";
import { startLoop } from "@/app/api/loops/start-loop";
import { readLoopRun, serializeLoop, writeLoopFile } from "@/lib/loops/store";
import { isAIConfigured, canWrite, DEPLOY_GUIDE_URL } from "@/lib/capabilities";
import type { LoopRun, LoopStep } from "@/lib/loops/types";
import { runRecallSearch, type RecallHit } from "@/lib/episodic/flash/recall";
import { readStrands } from "@/lib/episodic";
import { resolveWorkerModel } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";
import {
  parseSliceId,
  parseTurns,
  applyRange,
  reassembleSlice,
  type ParsedTurn,
} from "@/lib/episodic/turn-parser";

// ─── Shared tool contexts ────────────────────────────────────────────────

/**
 * Context each chat tool receives from WorkflowAgent's toolsContext mechanism.
 * Kept serializable so it survives workflow step boundaries.
 */
export interface ToolContext {
  /** GitHub repo name (or "local" when running without GITHUB_TOKEN). */
  repo: string;
  /** GitHub repo owner (or "local" when running without GITHUB_TOKEN). */
  owner: string;
  /** Whether GitHub token is configured. Off �?local filesystem. */
  useGithub: boolean;
  /** Whether demo mode is active (remote benchmark data, read-only). */
  useDemo: boolean;
  /** The current time-slice id (for startLoop to record the link). */
  sliceId: string;
  /** Recent conversation turns (last exchange + current user msg). */
  recentTurns: Array<{ role: string; content: string }>;
  /**
   * Resolved worker model for cheap internal calls (recall search, loops).
   * Set on the chat tool set; loops resolve it separately via their input.
   */
  workerModel?: ModelConfig;
  /**
   * Layer 3 dispatch context (chat tool set only): the main model for thinking
   * agents, the byte-identical shared prefix for cache-optimized parallel
   * thinkers, and the turn id for registering dispatched agents.
   */
  modelConfig?: ModelConfig;
  sharedContext?: string;
  turnId?: string;
}

/**
 * Context the loop's checkpoint tool receives �?the loop's own identity, so
 * loopReportExecute can do the read-append-write on the loop record file.
 */
export interface LoopToolContext {
  repo: string;
  owner: string;
  useGithub: boolean;
  loopId: string;
  goal: string;
  filePath: string;
  startedAt: string;
  sliceOrigin: string | null;
  tags: string[];
  maxIterations: number;
}

/** Shorthand for the options object each execute function receives. */
type ExecuteOpts<C> = {
  context: C;
};

// ─── Concept tool executors (chat + loop) ────────────────────────────────

/**
 * Deterministic domain outcomes ("file not found", etc.) must reach the MODEL
 * as tool results, not throw. A thrown error causes workflow retries on errors
 * that can never succeed.
 */
const DOMAIN_ERROR_RE =
  /^(File not found|Directory not found|Access denied)|is (a directory, not a file|not a regular file)|too large/;

function domainError(e: unknown): string | null {
  return e instanceof Error && DOMAIN_ERROR_RE.test(e.message)
    ? e.message
    : null;
}


// ── readSlice — read a time slice's core conversation ─────────────────

export async function readSliceExecute(
  { sliceId, range }: {
    sliceId: string;
    range?: { type: "turns" | "last" | "date"; indices?: number[]; count?: number; after?: string };
  },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const parsed = parseSliceId(sliceId);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`;
  try {
    let raw: string;
    if (ctx.useDemo) raw = await readFileDemo(path);
    else if (ctx.useGithub) raw = await readFile(path, ctx.repo, ctx.owner);
    else raw = await readFileLocal(path);

    // Apply range filter if requested
    if (range) {
      const { frontmatter, turns } = parseTurns(raw);
      const filtered = applyRange(turns, range);
      if (filtered.length === 0) {
        return `${frontmatter}\n\n_(No turns matched the requested range.)_`;
      }
      return reassembleSlice(frontmatter, filtered);
    }

    return raw;
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. This time slice does not exist.`;
  }
}

// ── listSlices �?browse slice directories ─────────────────────────────

export async function listSlicesExecute(
  { year, month }: { year?: number; month?: number },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }> | { error: string }> {
  "use step";
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const mo = month ?? now.getUTCMonth() + 1;
  const mm = String(mo).padStart(2, "0");
  const path = `memory/episodic/slices/${y}/${mm}`;

  try {
    if (ctx.useDemo) return await listFilesDemo(path);
    return ctx.useGithub
      ? await listFiles(path, ctx.repo, ctx.owner)
      : await listFilesLocal(path);
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return { error: `${msg}` };
  }
}

// ── readTimeline �?read monthly index ──────────────────────────────────

export async function readTimelineExecute(
  { year, month }: { year: number; month: number },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ exists: boolean; month: string; slices: unknown[] }> {
  "use step";
  const mm = String(month).padStart(2, "0");
  const path = `memory/episodic/slices/${year}/${mm}/_index.json`;
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    return JSON.parse(raw);
  } catch {
    return { exists: false, month: `${year}-${mm}`, slices: [] };
  }
}

// ── readStrand �?find slices by strand (tag) ───────────────────────────

export async function readStrandExecute(
  { strand }: { strand: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ strand: string; slices: string[]; exists: boolean }> {
  "use step";
  const path = "memory/episodic/strands.json";
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    const strands = JSON.parse(raw) as Record<string, string[]>;
    if (!strands[strand]) {
      return { strand, slices: [], exists: false };
    }
    return { strand, slices: strands[strand], exists: true };
  } catch {
    return { strand, slices: [], exists: false };
  }
}

// ── listStrands �?list all known strands ───────────────────────────────

export async function listStrandsExecute(
  _input: Record<string, never>,
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ strands: string[] }> {
  "use step";
  const path = "memory/episodic/strands.json";
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    const strands = JSON.parse(raw) as Record<string, string[]>;
    return { strands: Object.keys(strands) };
  } catch {
    return { strands: [] };
  }
}

// ── readAgentTimeline �?read the agent's cognition for a slice ──────────

export async function readAgentTimelineExecute(
  { sliceId }: { sliceId: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const parsed = parseSliceId(sliceId);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM.";
  }
  const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/agent.md`;
  try {
    if (ctx.useDemo) return await readFileDemo(path);
    return ctx.useGithub
      ? await readFile(path, ctx.repo, ctx.owner)
      : await readFileLocal(path);
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. Agent timeline not available for this slice.`;
  }
}

// ── readPreviously �?read the 前情提要 for a slice ─────────────────────

export async function readPreviouslyExecute(
  { sliceId }: { sliceId?: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const sid = sliceId ?? ctx.sliceId;
  const parsed = parseSliceId(sid);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM.";
  }
  const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/previously.md`;
  try {
    if (ctx.useDemo) return await readFileDemo(path);
    return ctx.useGithub
      ? await readFile(path, ctx.repo, ctx.owner)
      : await readFileLocal(path);
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. previously.md not available for this slice.`;
  }
}

// ─── Chat-only executors ─────────────────────────────────────────────────

/**
 * webSearch �?delegates to the Flash search adapter (see lib/search/). The
 * context is accepted for tool-set uniformity but unused: search needs no
 * repo identity. A missing API key is a deterministic config problem �?
 * returned as data; transient search failures throw and get the step retries.
 */
export async function webSearchExecute(
  { query }: { query: string },
  _opts: ExecuteOpts<ToolContext>,
): Promise<WebSearchResult | { error: string }> {
  "use step";
  if (!isAIConfigured()) {
    return { error: "Web search is not configured (DEEPSEEK_API_KEY missing)." };
  }

  return await searchViaFlash(query);
}

// ── recall �?semantic search across past conversation slices ─────────

/**
 * Recall search tool — Flash acts as a semantic search engine over the
 * episodic memory. Flash explores the global timeline, traces strands,
 * and deep-reads candidate slices, then returns pointers (which slices,
 * which turns, why relevant). The executor passes those pointers straight
 * back to Pro, which then calls readSlice for any content it wants. Flash
 * never produces summaries. */
export async function recallExecute(
  { query }: { query: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{
  hits: RecallHit[];
  confidence: number;
  reasoning: string;
}> {
  "use step";

  const strands = await readStrands();

  const searchResult = await runRecallSearch({
    query,
    currentSliceId: ctx.sliceId,
    owner: ctx.owner,
    repo: ctx.repo,
    strandsContext: strands,
    useGithub: ctx.useGithub,
    useDemo: ctx.useDemo,
    model: ctx.workerModel ?? (await resolveWorkerModel()),
  });

  // Flash returns pointers only �?the executor no longer reads raw content.
  // Pro should call readSlice (optionally with range) to fetch content from
  // slices it actually wants to use, keeping context usage minimal.
  return {
    hits: searchResult.hits,
    confidence: searchResult.confidence,
    reasoning: searchResult.reasoning,
  };
}

export async function startLoopExecute(
  { goal, tags }: { goal: string; tags?: string[] },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ ok: boolean; loopId?: string; runId?: string; filePath?: string; error?: string }> {
  "use step";

  // Demo mode: loops require a connected GitHub repo for write access.
  // The rejection is model-facing �?the model reads it and explains the
  // deployment requirement to the user naturally in the conversation.
  if (!canWrite()) {
    return {
      ok: false,
      error:
        "The user is currently in demo mode (read-only preview data, no connected " +
        "GitHub repository). Background loops need a real repository to write " +
        "progress to memory/loops/. Tell the user they need to deploy their own " +
        "instance to unlock background loops. Setup guide: " + DEPLOY_GUIDE_URL,
    };
  }

  try {
    const started = await startLoop({
      goal,
      tags: tags ?? [],
      sliceId: ctx.sliceId,
      workerModel: ctx.workerModel ?? (await resolveWorkerModel()),
    });
    // NOTE: the slice.loops / slice.tags back-reference is written by the chat
    // workflow's finalizeTurn step (which owns the slice by value) �?not here.
    return {
      ok: true,
      loopId: started.loopId,
      runId: started.runId,
      filePath: started.filePath,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "failed to start loop",
    };
  }
}

/**
 * thinkDeep — dispatch a background thinking agent (Layer 3). Fire-and-forget:
 * writes the task card, starts the durable think workflow, registers the agent
 * with the turn state, and returns immediately — the executor step NEVER waits
 * on the sub-agent (that would make the step = sub-agent runtime and blow the
 * 300s wall). The main turn workflow polls the report files and integrates.
 */
export async function thinkDeepExecute(
  { question, effort, outputFormat }: {
    question: string;
    effort: "low" | "high";
    outputFormat?: string;
  },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{
  ok: boolean;
  thinkId?: string;
  status?: string;
  error?: string;
}> {
  "use step";

  // Demo mode: thinking agents need a writable repo for their reports.
  if (!canWrite()) {
    return {
      ok: false,
      error:
        "The user is currently in demo mode (read-only preview data, no connected " +
        "GitHub repository). Thinking agents need a real repository to write their " +
        "reports. Tell the user they need to deploy their own instance to unlock " +
        "deep-thinking dispatch. Setup guide: " + DEPLOY_GUIDE_URL,
    };
  }

  if (!ctx.modelConfig || !ctx.sharedContext || !ctx.turnId) {
    return {
      ok: false,
      error:
        "Thinking agents are not configured for this turn (missing dispatch context). " +
        "This is an internal configuration issue.",
    };
  }

  const thinkId = `think-${Date.now()}-${crypto.randomBytes(3).toString("base64url")}`;
  const input: ThinkInput = {
    thinkId,
    question,
    effort,
    outputFormat,
    sharedContext: ctx.sharedContext,
    model: ctx.modelConfig,
    owner: ctx.owner,
    repo: ctx.repo,
    useGithub: ctx.useGithub,
    startedAt: new Date().toISOString(),
  };

  try {
    await writeTaskCard(input);
    await startThink(input);
    // Best-effort registration with the turn state (for the status endpoint).
    await appendThinkingAgent(ctx.turnId, thinkId).catch(() => {});
    return { ok: true, thinkId, status: "dispatched" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "failed to dispatch thinking agent",
    };
  }
}

// ─── continueOutput — the "not done yet" signal for long answers ──────────

/**
 * continueOutput — a no-op that simply opens another agent step.
 *
 * The model calls it mid-response when an answer is long: the tool result
 * triggers the next LLM step, which sees the partial text (kept in context)
 * and keeps writing. Its only job is the side effect of a step boundary — it
 * reads and writes nothing.
 */
export async function continueOutputExecute(
  _input: Record<string, never>,
  _opts: ExecuteOpts<ToolContext>,
): Promise<{ continued: true }> {
  "use step";
  return { continued: true };
}

// ─── Loop-only executor: the checkpoint tool ─────────────────────────────

/**
 * loopReport �?the loop's checkpoint. Each call appends one LoopStep to the
 * loop's markdown record (read-append-write; the file is the accumulator, so
 * progress survives any crash/retry) and emits a `data-loop` progress chunk to
 * the run's writable for live watchers. Replaces the old per-iteration
 * persistLoop + streamLoopProgress pair.
 */
export async function loopReportExecute(
  { action, result, done }: { action: string; result: string; done: boolean },
  { context: ctx }: ExecuteOpts<LoopToolContext>,
): Promise<{ recorded: true; step: number; done: boolean } | { error: string }> {
  "use step";

  // Demo mode safety net — startLoopExecute already blocks loops in demo,
  // but a loop agent started through another path should fail cleanly.
  if (!canWrite()) {
    return {
      error: "Loop progress cannot be recorded in demo mode. The loop should not have started.",
    };
  }

  const existing = await readLoopRun(ctx.filePath);
  const priorSteps: LoopStep[] = existing?.steps ?? [];
  const step: LoopStep = {
    step: priorSteps.length + 1,
    action,
    result,
    time: new Date().toISOString(),
  };
  const steps = [...priorSteps, step];

  const run: LoopRun = {
    loopId: ctx.loopId,
    goal: ctx.goal,
    status: "running", // final status is stamped by the workflow's finalizeLoop
    startedAt: ctx.startedAt,
    updatedAt: new Date().toISOString(),
    sliceOrigin: ctx.sliceOrigin,
    tags: ctx.tags,
    iterations: steps.length,
    maxIterations: ctx.maxIterations,
    lastError: existing?.lastError ?? "",
    steps,
  };
  await writeLoopFile(ctx.filePath, serializeLoop(run));

  // Live progress chunk �?best-effort: the memory-truth write above already
  // committed, so a stream failure must never fail the checkpoint.
  try {
    const writable = getWritable<UIMessageChunk>();
    const writer = writable.getWriter();
    await writer.write({
      type: "data-loop",
      id: `loop-${ctx.loopId}`,
      data: {
        loopId: ctx.loopId,
        goal: ctx.goal,
        status: "running",
        iteration: steps.length,
        latestStep: step,
        done: false,
      },
    } as UIMessageChunk);
    writer.releaseLock();
  } catch (err) {
    console.warn(
      `[Loop] progress chunk failed (loop=${ctx.loopId}):`,
      err instanceof Error ? err.message : err
    );
  }

  return { recorded: true, step: step.step, done };
}
