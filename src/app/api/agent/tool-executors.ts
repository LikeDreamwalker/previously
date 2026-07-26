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
// Side effect: register the DeepSeek model class in the step runtime's
// serialization registry (see register-model-classes.ts for why).
import "./register-model-classes";
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
import { runPreviouslyAgent, type PreviouslySignal, type PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";
import { applyPreviouslyAgentOutput } from "@/lib/episodic/previously-updater";
import { readPreviously, writePreviously, readAgentTimeline } from "@/lib/episodic";

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
  /** If a slice was just closed this turn, its slice id (for deep review). */
  closedSliceId?: string;
  /** Recent conversation turns (last exchange + current user msg). */
  recentTurns: Array<{ role: string; content: string }>;
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

/** Parse "YYYY-MM-DD-HHMM" into path segments. Returns null on invalid format. */
function parseSliceId(sliceId: string): { y: string; m: string; d: string; hm: string } | null {
  const parts = sliceId.split("-");
  if (parts.length !== 4) return null;
  const [y, m, d, hm] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d) || !/^\d{4}$/.test(hm)) {
    return null;
  }
  return { y, m, d, hm };
}

// ── Turn extraction helpers ──────────────────────────────────────────────

/** Parsed turn from a core.md slice file. */
interface ParsedTurn {
  index: number;
  header: string;   // "## Turn N -- ISO_TIMESTAMP (role)"
  content: string;   // turn body text
  timestamp: string; // ISO 8601
}

/** Regex for turn headers: "## Turn N -- ISO_TIMESTAMP (role)". */
const TURN_HEADER_RE = /^## Turn (\d+) -- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^)]*)\s*\((\w+)\)/;

/**
 * Parse core.md content into frontmatter + array of parsed turns.
 * Frontmatter is everything before the first turn header.
 */
function parseTurns(raw: string): { frontmatter: string; turns: ParsedTurn[] } {
  const lines = raw.split("\n");
  const turns: ParsedTurn[] = [];
  const frontmatterLines: string[] = [];
  let currentTurn: { index: number; header: string; timestamp: string; contentLines: string[] } | null = null;
  let inFrontmatter = true;

  for (const line of lines) {
    const match = line.match(TURN_HEADER_RE);
    if (match) {
      if (currentTurn) {
        turns.push({
          index: currentTurn.index,
          header: currentTurn.header,
          timestamp: currentTurn.timestamp,
          content: currentTurn.contentLines.join("\n").trimEnd(),
        });
      }
      currentTurn = {
        index: parseInt(match[1], 10),
        header: line,
        timestamp: match[2],
        contentLines: [],
      };
      inFrontmatter = false;
    } else if (inFrontmatter) {
      frontmatterLines.push(line);
    } else if (currentTurn) {
      currentTurn.contentLines.push(line);
    }
  }
  // Don't forget the last turn
  if (currentTurn) {
    turns.push({
      index: currentTurn.index,
      header: currentTurn.header,
      timestamp: currentTurn.timestamp,
      content: currentTurn.contentLines.join("\n").trimEnd(),
    });
  }

  return { frontmatter: frontmatterLines.join("\n").trimEnd(), turns };
}

/** Apply a range filter to parsed turns. Returns the filtered turns array. */
function applyRange(
  turns: ParsedTurn[],
  range: { type: "turns" | "last" | "date"; indices?: number[]; count?: number; after?: string },
): ParsedTurn[] {
  switch (range.type) {
    case "turns": {
      if (!range.indices || range.indices.length === 0) return turns;
      const indexSet = new Set(range.indices);
      return turns.filter((t) => indexSet.has(t.index));
    }
    case "last": {
      const n = range.count ?? 3;
      return turns.slice(-n);
    }
    case "date": {
      if (!range.after) return turns;
      const afterMs = new Date(range.after).getTime();
      if (isNaN(afterMs)) return turns;
      return turns.filter((t) => new Date(t.timestamp).getTime() >= afterMs);
    }
    default:
      return turns;
  }
}

/** Reassemble filtered turns into markdown: frontmatter + selected turn headers & content. */
function reassembleSlice(frontmatter: string, turns: ParsedTurn[]): string {
  const parts = [frontmatter];
  for (const t of turns) {
    parts.push(`\n${t.header}\n${t.content}`);
  }
  return parts.join("\n");
}

// ── readSlice �?read a time slice's core conversation ─────────────────

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
    return `ERROR: ${msg}. 前情提要 not available for this slice.`;
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
 * Recall search tool �?Flash acts as a semantic search engine over the
 * episodic memory. Flash explores the global timeline, traces strands,
 * and deep-reads candidate slices, then returns pointers (which slices,
 * which turns, why relevant). The executor reads the RAW slice content
 * and returns it to Pro �?Flash never produces summaries.
 */
export async function recallExecute(
  { query }: { query: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{
  hits: RecallHit[];
  confidence: number;
  reasoning: string;
}> {
  "use step";

  const searchResult = await runRecallSearch({
    query,
    currentSliceId: ctx.sliceId,
    owner: ctx.owner,
    repo: ctx.repo,
    useGithub: ctx.useGithub,
    useDemo: ctx.useDemo,
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

/**
 * updatePreviously �?signal the Previously Agent to review and update the
 * agent's self-model (previously.md). The core agent calls this when it notices
 * something worth remembering, or when the user corrects it, or when a slice
 * just closed.
 *
 * The Previously Agent (Flash) runs synchronously within this step but the
 * core agent does not see the result �?the updated previously.md is available
 * next turn. The tool returns an acknowledgment with a changes summary.
 */
export async function updatePreviouslyExecute(
  { signal, note, priority }: {
    signal: PreviouslySignal;
    note?: string;
    priority?: "normal" | "high";
  },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{
  acknowledged: boolean;
  changes?: { added: number; reinforced: number; demoted: number; removed: number; superseded: number };
  mutations?: PreviouslyMutation[];
  error?: string;
}> {
  "use step";

  try {
    // Pre-load data the Previously Agent always needs (shallow-edit baseline).
    let previouslyContent = "";
    try { previouslyContent = await readPreviously(ctx.sliceId); } catch { /* use empty */ }
    let agentCognition = "";
    try { agentCognition = await readAgentTimeline(ctx.sliceId); } catch { /* no agent.md yet */ }

    // Run Previously Agent �?it decides whether to do shallow edit or deep explore.
    const result = await runPreviouslyAgent({
      signal,
      note: note ?? "",
      currentSliceId: ctx.sliceId,
      closedSliceId: ctx.closedSliceId,
      previouslyContent,
      agentCognition,
      recentTurns: ctx.recentTurns,
      readSliceFn: async (sliceId: string, range?) => {
        // Reuse the same read logic as readSliceExecute.
        const parsed = parseSliceId(sliceId);
        if (!parsed) return `ERROR: Invalid slice ID. Expected YYYY-MM-DD-HHMM.`;
        const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`;
        try {
          let raw: string;
          if (ctx.useDemo) raw = await readFileDemo(path);
          else if (ctx.useGithub) raw = await readFile(path, ctx.repo, ctx.owner);
          else raw = await readFileLocal(path);
          if (range) {
            const { frontmatter, turns } = parseTurns(raw);
            const filtered = applyRange(turns, range);
            if (filtered.length === 0) return `${frontmatter}\n\n_(No turns matched.)_`;
            return reassembleSlice(frontmatter, filtered);
          }
          return raw;
        } catch { return `(slice not found: ${sliceId})`; }
      },
      readAgentTimelineFn: async (sid: string) => {
        try { return await readAgentTimeline(sid); } catch { return `(not found: ${sid})`; }
      },
      readPreviouslyFn: async (sid: string) => {
        try { return await readPreviously(sid); } catch { return `(not found: ${sid})`; }
      },
    });

    // Log reasoning for developers �?NOT returned to core agent.
    if (result.reasoning) {
      console.log(`[Previously] reasoning: ${result.reasoning}`);
    }

    if (result.mutations.length === 0) {
      return {
        acknowledged: true,
        changes: { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 },
        mutations: [],
      };
    }

    // Apply mutations to the pre-loaded content (re-read in case agent mutated via tools).
    // Actually the agent doesn't mutate via tools �?it only reads. Use the pre-loaded content.
    const applied = applyPreviouslyAgentOutput(previouslyContent, result.mutations, ctx.sliceId);
    await writePreviously(ctx.sliceId, applied.content);

    console.log(
      `[Previously] ${signal}: ${applied.changes.added} added, ` +
      `${applied.changes.reinforced} reinforced, ${applied.changes.demoted} demoted, ` +
      `${applied.changes.removed} removed.`,
    );

    return { acknowledged: true, changes: applied.changes, mutations: result.mutations };
  } catch (err) {
    console.warn("[Previously] updatePreviouslyExecute failed:", err instanceof Error ? err.message : err);
    return { acknowledged: true, error: "Previously Agent unavailable �?will retry next turn." };
  }
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
): Promise<{ recorded: true; step: number; done: boolean }> {
  "use step";

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
