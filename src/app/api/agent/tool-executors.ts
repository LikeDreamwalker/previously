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

import { streamText, type UIMessageChunk } from "ai";
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
import { isPrivateHost, extractText, fetchWithGuard } from "@/lib/search/fetch-utils";
import { startLoop } from "@/app/api/loops/start-loop";
import { readLoopRun, serializeLoop, writeLoopFile } from "@/lib/loops/store";
import { isAIConfigured, canWrite, DEPLOY_GUIDE_URL } from "@/lib/capabilities";
import { LOOP_WALL_CLOCK_MS, type LoopRun, type LoopStep } from "@/lib/loops/types";
import {
  runRecallSearch,
  type RecallHit,
  type RecommendedRead,
} from "@/lib/episodic/flash/recall";
import { readStrands, CURRENT_PREVIOUSLY_PATH } from "@/lib/episodic";
import { migrateToV3, isCardFormat } from "@/lib/episodic/previously-format";
import {
  annotateSliceWithLocalTime,
  sliceLocalBanner,
  sliceIdLocalClock,
  sliceIdRelPhrase,
} from "@/lib/episodic/time-localize";
import { normalizeLocale } from "@/lib/time/relative";
import { formatLocalTime } from "@/lib/turn-priming";
import {
  splitTurns,
  splitParagraphs,
  segmentSearch,
  textLines,
  searchResultToString,
} from "@/lib/retrieval/doc-segments";
import { resolveWorkerModel, resolveMainModelFromConfig } from "@/lib/models/worker";
import { createModel } from "@/lib/models/provider";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import type { ModelConfig } from "@/lib/models/registry";
import { withStepTimeout } from "@/lib/chat/step-timeout";
import { isTransientError, triageErrorMessage } from "@/lib/chat/tool-triage";
import {
  shouldEmitProgress,
  type ProgressWriteState,
} from "@/lib/chat/progress-throttle";
import {
  parseSliceId,
  parseTurns,
  applyRange,
  reassembleSlice,
  type ParsedTurn,
} from "@/lib/episodic/turn-parser";
import matter from "gray-matter";
import { sliceLine } from "@/lib/episodic/timeline/render";
import { TIMELINE_INDEX_PATH } from "@/lib/episodic/timeline/store";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

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
   * The turn's assembled system prompt (see turn-workflow.ts). thinkDeep reads
   * it to reuse the main agent's exact prompt prefix, so sub-agent calls hit
   * the provider's prompt cache warmed by the main agent's first step. Absent
   * on the loop tool set (no thinkDeep there).
   */
  baseSystemPrompt?: string;
  /**
   * Resolved worker model for cheap internal calls (recall search, loops).
   * Set on the chat tool set; loops resolve it separately via their input.
   */
  workerModel?: ModelConfig;
  /**
   * The turn's resolved MAIN model — the same config injected for the main
   * agent. thinkDeep uses it directly so each reasoning fragment skips the
   * per-step `resolveMainModelFromConfig()` GitHub round-trip. Set on the chat
   * tool set; absent on the loop tool set (no thinkDeep there).
   */
  mainModel?: ModelConfig;
  /**
   * The user's IANA timezone (e.g. "Asia/Shanghai") — read tools use it to
   * pre-render local-time annotations so the agent never converts UTC itself.
   * Set on the chat tool set; absent on the loop tool set.
   */
  timezone?: string;
  /** The turn's start instant (UTC ISO) — anchors local-time rendering. */
  startedAtIso?: string;
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale?: string;
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

/**
 * Shorthand for the options object each execute function receives.
 *
 * The AI SDK's `ToolExecutionOptions` provides `{ toolCallId, messages,
 * abortSignal, context, ... }`; we narrow it to the fields our executors use.
 * `toolCallId` is the client-side routing key for `data-tool-progress` chunks
 * (merged into the matching tool card in buildStream).
 */
type ExecuteOpts<C> = {
  context: C;
  toolCallId: string;
};

/**
 * Best-effort live progress write to the run stream (`data-tool-progress`),
 * routed client-side by `toolCallId` into the matching tool card. One write per
 * call — tools that want continuous streaming throttle on their own (thinkDeep)
 * and await the write when the status must settle BEFORE the tool result is
 * ordered (webSearch / recall emit a final "found N" status). A stream failure
 * must never fail the tool, so write errors are swallowed and the lock released
 * after each write (an unreleased lock keeps the step's HTTP request alive).
 */
function emitToolProgress(
  toolCallId: string,
  toolName: string,
  text: string,
  stage?: string,
): Promise<void> {
  try {
    const writer = getWritable<UIMessageChunk>().getWriter();
    return writer
      .write({
        type: "data-tool-progress",
        id: `tool-${toolCallId}`,
        data: { toolCallId, toolName, text, stage },
      })
      .then(() => writer.releaseLock())
      .catch(() => {});
  } catch {
    // getWritable() can throw outside a step context — never fail the tool.
    return Promise.resolve();
  }
}

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

/** Range filter for readSlice. Extends the classic turn filters (turns / last /
 *  date) with the shared Document Segment Read protocol: keyword search
 *  (`search`, hits degrade to the full slice) and line ranges (`lines`). */
export type ReadSliceRange = {
  type: "turns" | "last" | "date" | "search" | "lines";
  indices?: number[];
  count?: number;
  after?: string;
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

export async function readSliceExecute(
  { sliceId, range }: { sliceId: string; range?: ReadSliceRange },
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
    let content: string;
    if (range) {
      // Keyword search — the Document Segment Read protocol. Matches return
      // only the relevant turns; a miss degrades to the full slice with a note.
      if (range.type === "search") {
        const keywords = range.keywords ?? [];
        const context = range.context ?? 1;
        const segments = splitTurns(raw);
        const hits = segmentSearch(segments, keywords, context, context);
        content = searchResultToString(sliceId, keywords, hits, raw);
      } else if (range.type === "lines") {
        // Line range — read the file like a code file, 1-indexed inclusive.
        const { content: lineContent, clamped } = textLines(raw, range.start ?? 1, range.end ?? 1);
        if (lineContent === "" && (range.start ?? 1) > (range.end ?? 1)) {
          return `ERROR: Invalid line range ${range.start}-${range.end} in ${sliceId}.`;
        }
        const header = `Lines ${range.start}-${range.end} of ${sliceId}${clamped ? " (clamped)" : ""}:\n\n`;
        content = lineContent === "" ? `${header}(empty range)` : header + lineContent;
      } else {
        // Classic turn filters.
        const { frontmatter, turns } = parseTurns(raw);
        const filtered = applyRange(turns, range as { type: "turns" | "last" | "date" });
        content =
          filtered.length === 0
            ? `${frontmatter}\n\n_(No turns matched the requested range.)_`
            : reassembleSlice(frontmatter, filtered);
      }
    } else {
      content = raw;
    }

    // Pre-render the user's local time so the agent never converts UTC itself.
    return ctx.timezone
      ? annotateSliceWithLocalTime(content, ctx.timezone, sliceId)
      : content;
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. This time slice does not exist.`;
  }
}

// ── readSliceSummary — frontmatter only (the cheapest relevance check) ──

export async function readSliceSummaryExecute(
  { sliceId }: { sliceId: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  const parsed = parseSliceId(sliceId);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`;
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    const { data } = matter(raw);
    const { turns } = parseTurns(raw);
    const fmt = (v: unknown): string =>
      Array.isArray(v) && v.length ? v.join("; ") : "(none)";
    const lines = [
      `slice ${sliceId}`,
      `start: ${typeof data.start === "string" ? data.start : "?"}`,
      `end: ${typeof data.end === "string" ? data.end : "(active)"}`,
      `turns: ${turns.length}`,
      `focus: ${typeof data.focus === "string" && data.focus ? data.focus : "(none)"}`,
      `summary: ${typeof data.summary === "string" && data.summary ? data.summary : "(none)"}`,
      `tags: ${fmt(data.tags)}`,
      `tone: ${typeof data.emotional_tone === "string" && data.emotional_tone ? data.emotional_tone : "(none)"}`,
      `open_loops: ${fmt(data.open_loops)}`,
      `decisions: ${fmt(data.decisions)}`,
    ];
    const note = ctx.timezone ? `\n(时间均为 UTC；本地时区 ${ctx.timezone})` : "";
    return lines.join("\n") + note;
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    return `ERROR: ${msg}. This time slice does not exist.`;
  }
}

// ── readTimelineWindow — the timeline catalog over a date window ────────

export async function readTimelineWindowExecute(
  { from, to, limit }: { from?: string; to?: string; limit?: number },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(TIMELINE_INDEX_PATH)
      : ctx.useGithub
        ? await readFile(TIMELINE_INDEX_PATH, ctx.repo, ctx.owner)
        : await readFileLocal(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as { slices?: TimelineSliceEntry[] };
    const slices = (idx.slices ?? [])
      .filter((s) => {
        const date = s.id.slice(0, 10); // "YYYY-MM-DD"
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      })
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, limit ?? 20);
    if (slices.length === 0) {
      return `(时间线窗口 ${from ?? "开始"} → ${to ?? "现在"} 内没有切片)`;
    }
    const windowLabel = `${from ?? "开始"} → ${to ?? "现在"}`;
    return `时间线窗口 ${windowLabel}（${slices.length} 片，每一行是指针，不是内容——相关就先 readSliceSummary / readSlice）：\n\n${slices.map(sliceLine).join("\n")}`;
  } catch {
    return "(时间线目录尚不可用——weave 尚未运行，或演示数据没有目录)";
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
): Promise<{ exists: boolean; month: string; slices: unknown[]; timezoneNote?: string }> {
  "use step";
  const mm = String(month).padStart(2, "0");
  const path = `memory/episodic/slices/${year}/${mm}/_index.json`;
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    const data = JSON.parse(raw) as { exists: boolean; month: string; slices: unknown[] };

    // Pre-render each slice's start in the user's local time so the agent never
    // converts UTC itself (see time-localize.ts).
    if (Array.isArray(data.slices) && ctx.timezone) {
      const tz = ctx.timezone; // narrowed string — stable across the map closure
      const slices = data.slices.map((s) => {
        if (s && typeof s === "object" && "start" in s && typeof (s as { start?: unknown }).start === "string") {
          const rec = s as Record<string, unknown>;
          return { ...rec, localStart: formatLocalTime(rec.start as string, tz).local };
        }
        return s;
      });
      return {
        ...data,
        slices,
        timezoneNote: `每个 slice 已附带 localStart（用户当地，${tz}）；start 为原始 UTC。`,
      };
    }
    return data;
  } catch {
    return { exists: false, month: `${year}-${mm}`, slices: [] };
  }
}

// ── readStrand �?find slices by strand (tag) ───────────────────────────

export async function readStrandExecute(
  { strand }: { strand: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ strand: string; slices: string[]; exists: boolean; timezoneNote?: string }> {
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
    // Slice paths are UTC-derived (HHMM is UTC). readSlice already annotates the
    // user's local time on the content it returns — this note is a reminder.
    const timezoneNote = ctx.timezone
      ? `这些 slice 路径是 UTC 派生（HHMM 为 UTC）。需要具体当地时刻时用 readSlice 读取该切片，返回内容已标注本地时钟（${ctx.timezone}）。`
      : undefined;
    return { strand, slices: strands[strand], exists: true, timezoneNote };
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

  // No sliceId → the LIVE card (current-previously.md), the one the current
  // conversation actually runs on (v0.7 real-time card). A per-slice arg reads
  // that slice's historical snapshot.
  if (!sliceId) {
    const raw = ctx.useDemo
      ? await readFileDemo(CURRENT_PREVIOUSLY_PATH)
      : ctx.useGithub
        ? await readFile(CURRENT_PREVIOUSLY_PATH, ctx.repo, ctx.owner)
        : await readFileLocal(CURRENT_PREVIOUSLY_PATH);
    return raw.trim() ? (isCardFormat(raw) ? raw : migrateToV3(raw, "current")) : raw;
  }

  const sid = sliceId;
  const parsed = parseSliceId(sid);
  if (!parsed) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM.";
  }
  const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/previously.md`;
  try {
    // Legacy (v1/v2) files are migrated on the fly; the v4 user card is read
    // as-is. Never exposes the old 长期记忆/短期记忆 headers.
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    const content = raw.trim() ? migrateToV3(raw, sid) : raw;
    if (!ctx.timezone || content === "") return content;
    // Prepend the user-local time banner so the model knows when the snapshot
    // was taken without converting the UTC Updated stamp itself.
    return `${sliceLocalBanner(sid, ctx.timezone)}\n\n${content}`;
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
  { toolCallId }: ExecuteOpts<ToolContext>,
): Promise<WebSearchResult | { error: string }> {
  "use step";
  // Status subtitle streams for the whole execution; awaited so it is ordered
  // before the result.
  await emitToolProgress(toolCallId, "webSearch", "Searching the web…", "running");

  // webSearch is a DEEPSEEK-ONLY infra call (see lib/search/flash-search.ts
  // @security note). Gate on the key itself, not the generic isAIConfigured():
  // a deployment with ANTHROPIC_API_KEY but no DEEPSEEK_API_KEY would pass the
  // generic check and then fail deep inside the adapter.
  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      error:
        "Web search requires a DEEPSEEK_API_KEY. It runs as a separate DeepSeek " +
        "infrastructure call independent of the chat model you selected. Add " +
        "DEEPSEEK_API_KEY to enable it, or swap in your own search adapter.",
    };
  }

  // Soft 60s safety net. searchViaFlash errors (transient search failures)
  // still throw and get step retries — only a timeout returns an error result.
  let timed: Awaited<ReturnType<typeof withStepTimeout<WebSearchResult>>>;
  try {
    timed = await withStepTimeout(
      () =>
        searchViaFlash(query, (text) => {
          void emitToolProgress(toolCallId, "webSearch", text, "running");
        }),
      60_000,
    );
  } catch (err) {
    // Triage: deterministic failures (schema validation, config, domain) become
    // a model-readable tool result so the workflow does NOT retry them. Only
    // genuinely transient errors re-throw for the step's auto-retry.
    if (isTransientError(err)) throw err;
    console.warn(
      "[WebSearch] triaged failure:",
      err instanceof Error ? err.message : err,
    );
    return { error: triageErrorMessage(err, "webSearch") };
  }

  if (!timed.ok || timed.result === undefined) {
    return {
      error: timed.ok
        ? "Web search returned no result"
        : `Web search timed out after ${timed.elapsedMs}ms`,
    };
  }

  // Settle the subtitle on the outcome before the tool result lands, so the
  // typewriter box ends on "Found N sources" instead of the stale "Searching…".
  const result = timed.result;
  await emitToolProgress(
    toolCallId,
    "webSearch",
    `Found ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`,
    "done",
  );
  return result;
}

// ── webFetch — fetch a specific page's text content ────────────────────

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_CHARS = 15_000;

/**
 * webFetch — read a specific URL's page text, server-side.
 *
 * The web complement of readSlice: the main agent points at one item (a URL
 * instead of a slice id) and gets its raw content back for the model to
 * digest. Used when the user pastes a link, or when a webSearch recommendation
 * suggests a page is worth reading. Returns the extracted prose (scripts and
 * styles stripped), truncated to keep context bounded.
 *
 * Optional `range` applies the shared Document Segment Read protocol: keyword
 * search (matches → relevant paragraphs; miss → full text + note) or line
 * ranges (1-indexed, like reading a code file).
 *
 * Security: only http(s) schemes and non-private hostnames are fetchable.
 * The Vercel sandbox is the real boundary; this validation is defense-in-depth.
 */
export type WebFetchRange = {
  type: "search" | "lines";
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

export async function webFetchExecute(
  { url, range }: { url: string; range?: WebFetchRange },
  _opts: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "ERROR: Invalid URL. Pass a full absolute URL, e.g. 'https://example.com/article'.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "ERROR: Unsupported URL protocol. Only http:// and https:// are allowed.";
  }
  if (isPrivateHost(parsed.hostname)) {
    return "ERROR: Cannot fetch local or private network addresses.";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchWithGuard(parsed.toString(), {
      signal: controller.signal,
    });
    if (!res.ok) {
      return `ERROR: HTTP ${res.status} ${res.statusText}`;
    }
    const text = await res.text();
    const extracted = extractText(text);

    // Document Segment Read protocol — applied before truncation so a matched
    // subset or line range is returned in full, not capped by the 15K fallback.
    if (range) {
      if (range.type === "search") {
        const keywords = range.keywords ?? [];
        const context = range.context ?? 1;
        const hits = segmentSearch(splitParagraphs(extracted), keywords, context, context);
        return searchResultToString(parsed.hostname + parsed.pathname, keywords, hits, extracted);
      }
      if (range.type === "lines") {
        const { content, clamped } = textLines(extracted, range.start ?? 1, range.end ?? 1);
        if (content === "" && (range.start ?? 1) > (range.end ?? 1)) {
          return `ERROR: Invalid line range ${range.start}-${range.end} for ${parsed.hostname}.`;
        }
        const header = `Lines ${range.start}-${range.end} of ${parsed.hostname}${clamped ? " (clamped)" : ""}:\n\n`;
        return content === "" ? `${header}(empty range)` : header + content;
      }
    }

    if (extracted.length > WEB_FETCH_MAX_CHARS) {
      return (
        extracted.slice(0, WEB_FETCH_MAX_CHARS) +
        `\n\n(Truncated at ${WEB_FETCH_MAX_CHARS} characters)`
      );
    }
    return extracted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `ERROR: Could not fetch URL: ${msg}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── recall �?semantic search across past conversation slices ─────────

/**
 * Recall search tool — Flash acts as a summary-level search engine over the
 * episodic memory. Flash reads the global timeline summaries, traces strands,
 * and returns pointers (which slices, which turns, why relevant) PLUS a
 * recommendation list of slices worth opening. Flash never reads slice bodies
 * and never produces content summaries. Pro decides which (if any) slices to
 * open with readSlice — the summaries may already be enough. */
export async function recallExecute(
  { query }: { query: string },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<{
  hits: RecallHit[];
  confidence: number;
  reasoning: string;
  recommendedReads: RecommendedRead[];
  /** Set when no matches were found — a definitive signal that recall is exhausted for this query. */
  note?: string;
}> {
  "use step";
  await emitToolProgress(toolCallId, "recall", "Scanning memory slices…", "running");

  try {
    const strands = await readStrands();

    // Soft 120s safety net. Recall is best-effort: a timeout returns an empty
    // search rather than failing the step, so the main agent knows nothing was
    // found instead of a hard error.
    //
    // Cancellation: withStepTimeout aborts its signal on timeout, but
    // runRecallSearch's generateText has no abortSignal param to consume it,
    // so the loser runs to completion in the background. That is harmless
    // here — recall is read-only and its late result is discarded by the race.
    const workerModel = ctx.workerModel ?? (await resolveWorkerModel());
    const timed = await withStepTimeout(
      () =>
        runRecallSearch({
          query,
          currentSliceId: ctx.sliceId,
          owner: ctx.owner,
          repo: ctx.repo,
          strandsContext: strands,
          useGithub: ctx.useGithub,
          useDemo: ctx.useDemo,
          model: workerModel,
          // Stream each sub-agent tool step ("Reading global timeline…",
          // "Tracing strand: X…") into the typewriter subtitle as it happens.
          onProgress: (text) => {
            void emitToolProgress(toolCallId, "recall", text, "thinking");
          },
        }),
      120_000,
    );

    if (!timed.ok || timed.result === undefined) {
      return {
        hits: [],
        confidence: 0,
        reasoning: timed.ok
          ? "Recall search returned no result"
          : `Recall search timed out after ${timed.elapsedMs}ms`,
        recommendedReads: [],
      };
    }

    // Settle the subtitle on the outcome before the tool result lands.
    const result = timed.result;
    await emitToolProgress(
      toolCallId,
      "recall",
      `Found ${result.hits.length} match${result.hits.length === 1 ? "" : "es"}`,
      "done",
    );

    // Flash returns pointers + recommendations only — it never reads slice bodies.
    // Pro should call readSlice (optionally with range) to fetch content from
    // slices it actually wants to use, keeping context usage minimal.
    const emptyNote =
      result.hits.length === 0
        ? "No relevant past conversations were found for this query. This is a definitive result — do NOT call recall again for this topic; answer from the conversation and your knowledge."
        : undefined;

    // Pre-render each hit's local clock + relative days (from its UTC-derived
    // slice id) so the agent knows WHEN a past conversation happened without
    // converting UTC or doing date arithmetic itself.
    const annotateReason = (reason: string, sliceId: string) => {
      if (!ctx.timezone) return reason;
      const clock = sliceIdLocalClock(sliceId, ctx.timezone);
      if (!clock) return reason;
      const rel = sliceIdRelPhrase(sliceId, ctx.timezone, {
        nowIso: ctx.startedAtIso,
        locale: ctx.locale ?? "en",
      });
      const inner = rel ? `${clock} · ${rel}` : clock;
      return normalizeLocale(ctx.locale) === "zh"
        ? `${reason}（本地 ${inner}）`
        : `${reason} (local ${inner})`;
    };
    return {
      hits: result.hits.map((h) => ({ ...h, reason: annotateReason(h.reason, h.slice_id) })),
      confidence: result.confidence,
      reasoning: result.reasoning,
      recommendedReads: result.recommendedReads.map((r) => ({
        ...r,
        reason: annotateReason(r.reason, r.slice_id),
      })),
      ...(emptyNote ? { note: emptyNote } : {}),
    };
  } catch (err) {
    // Triage: a deterministic recall failure returns as data so the model sees
    // "recall is unavailable" instead of a thrown error retrying the step.
    if (isTransientError(err)) throw err;
    console.warn(
      "[Recall] triaged failure:",
      err instanceof Error ? err.message : err,
    );
    return {
      hits: [],
      confidence: 0,
      reasoning: triageErrorMessage(err, "recall"),
      recommendedReads: [],
    };
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
    // The workflow-initiation HTTP call can hang on a stuck Vercel Workflow API;
    // a 30s soft timeout bounds the step without aborting the durable run (the
    // run is idempotent — a retry re-fires startLoop safely).
    const startedCall = await withStepTimeout(
      async () =>
        startLoop({
          goal,
          tags: tags ?? [],
          sliceId: ctx.sliceId,
          workerModel: ctx.workerModel ?? (await resolveWorkerModel()),
        }),
      30_000,
    );
    if (!startedCall.ok || startedCall.result === undefined) {
      return {
        ok: false,
        error: `Starting the loop timed out after ${Math.round(startedCall.elapsedMs / 1000)}s. ` +
          "The background run may still start on its own; try again in a moment.",
      };
    }
    const started = startedCall.result;
    // NOTE: the slice.loops / slice.tags back-reference is written by the chat
    // workflow's finalizeTurn step (which owns the slice by value) — not here.
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
 * thinkDeep — a reasoning fragment (think-only sub-agent).
 *
 * Runs ONE bounded reasoning fragment as a single synchronous `streamText`
 * call INSIDE this step, using the user's MAIN model at the requested thinking
 * intensity. The sub-agent is think-only: NO tools, NO search — it reasons over
 * the information the main agent embedded in the question and writes its
 * conclusion. The conclusion + reasoning trail flow back as the tool result,
 * and the WorkflowAgent loop integrates them naturally on the next step.
 *
 * TIME-based truncation, NOT token-based: there is deliberately NO
 * `maxOutputTokens` here. A hard token cap is invisible to the model — it can't
 * pace itself within it, and with thinking enabled the reasoning silently eats
 * the shared budget, leaving an empty/truncated report (the old 3500-token
 * behavior). Instead the step is bounded by wall-clock and the SDK's native
 * timeout hook:
 *
 *   - `streamText({ timeout })` is the PRIMARY hook: the SDK runs
 *     `AbortSignal.timeout()` (available here — this is real Node in a
 *     `"use step"`, unlike the deterministic workflow body) and ABORTS the
 *     stream cleanly at the deadline, surfacing as `AbortError`. The value is
 *     adaptive: `STEP_TOTAL_MS` minus the prologue already elapsed, so the step
 *     returns right around STEP_TOTAL_MS regardless of setup overhead — safely
 *     under the 300s platform wall.
 *   - `withStepTimeout` is the backstop: if the SDK abort somehow doesn't
 *     surface, it still returns a structured result before the wall, so the
 *     step NEVER dies silently.
 *
 * BOTH output channels are captured live via `onChunk`: `text-delta` (the
 * written answer) and `reasoning-delta` (the thinking trail). On timeout the
 * main agent receives the partial answer AND the full reasoning so far — the
 * sub-agent's thinking is never lost, even if it is interrupted mid-thought.
 *
 * Why think-only? A sub-agent with tools re-runs the search/recall the main
 * agent already did, and an unbounded tool-loop + thinking guarantees it
 * exhausts the wall before writing (the v2 empty-report bug). Think-only
 * fragments are single-invocation, bounded by construction, and cannot cascade.
 *
 * Provider options are built inline here — this module must NOT import from
 * ./agent.ts, which pulls `@ai-sdk/workflow` into the step bundle.
 */
/**
 * Total target for the whole thinkDeep step — the maximum safely usable under
 * the 300s platform wall. The SDK abort + catch + return path needs a few
 * hundred ms, and cold-start (unmeasurable from inside the handler) silently
 * eats into the wall, so we cannot target the full 300s. 295s leaves ~4s of
 * margin on the primary path; the backstop fires 3s later at ~298s with ~2s to
 * return — past that the platform kill would win the race.
 */
const STEP_TOTAL_MS = 295_000;

/** Guidance the main agent reads when a reasoning fragment is interrupted. */
const SUB_AGENT_TIMEOUT_NOTE =
  "The reasoning fragment was interrupted before finishing. The `answer` holds " +
  "the partial conclusion and `reasoning` the thinking trail it already produced " +
  "— work with them (noting the uncertainty). If you need more, gather the " +
  "missing information yourself (webSearch/recall), embed it, and dispatch a " +
  "finer fragment. Do not re-dispatch the same question unchanged — a fragment " +
  "that timed out will likely time out again.";

/** Structured result a thinkDeep reasoning fragment returns to the main agent. */
export interface ThinkDeepResult {
  ok: boolean;
  /** completed = answer is whole; timeout = answer is partial (may be empty); error = nothing usable. */
  status: "completed" | "timeout" | "error";
  /** The fragment's conclusion — full, or partial when interrupted. */
  answer?: string;
  /** The fragment's thinking trail — always captured; returned on completion AND timeout. */
  reasoning?: string;
  /** Human-readable failure / interruption reason. */
  error?: string;
  /** For `timeout`: what the main agent can do next. Absent otherwise. */
  note?: string;
}

/** Detect the SDK `timeout` abort — the SDK's `AbortSignal.timeout()` surfaces as name "AbortError". */
function isTimeoutAbort(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
/**
 * The think-only task assignment, appended AFTER the caller's full system
 * prompt (when available) so sub-agents share the main agent's exact prefix —
 * the provider's prompt cache, warmed by the main agent's first step, is hit by
 * every sub-agent call in the same turn. When no baseSystemPrompt flows through
 * the context (e.g. loops), SUB_AGENT_SYSTEM_PROMPT stands alone.
 */
const SUB_AGENT_FRAGMENT_MODE = `Your ONLY job is to reason through the sub-question below to a clear conclusion,
then write that conclusion. You are THINK-ONLY: you have no search, no memory
tools — every fact you need is already embedded in the question. Do not ask for
information; reason with what you are given and state plainly anything you lack.

Writing discipline (critical):
- A hard deadline will cut you off. Write your conclusion AS YOU GO — every
  sentence you emit is preserved and returned to the caller. Do not save all
  writing for the end.
- Keep it short and decisive. This is one fragment of a larger reasoning, not
  a report — a few paragraphs at most.
- If you reach a conclusion, state it clearly at the end ("Conclusion: …").
- If the question cannot be answered from the given information, say exactly
  what is missing and why.

Answer in the language of the question.`;

/** Standalone system prompt when the turn supplies no baseSystemPrompt. */
const SUB_AGENT_SYSTEM_PROMPT = `You are the same agent as the caller, working on ONE small reasoning fragment.

${SUB_AGENT_FRAGMENT_MODE}`;

/** System prompt for a think-only fragment — base prompt prefix + fragment task. */
function buildSubAgentSystemPrompt(baseSystemPrompt: string | undefined): string {
  if (!baseSystemPrompt) return SUB_AGENT_SYSTEM_PROMPT;
  return `${baseSystemPrompt}\n\n## Reasoning fragment mode\n\n${SUB_AGENT_FRAGMENT_MODE}`;
}

/** One fragment as the model supplies it in the batch call. */
export interface ThinkDeepFragmentInput {
  question: string;
  effort?: "low" | "medium" | "high";
}

/** One fragment's structured result, tagged with its question. */
export interface ThinkDeepFragmentResult extends ThinkDeepResult {
  question: string;
}

/**
 * thinkDeep — ONE reasoning fragment, dispatched as its own sub-agent call.
 *
 * The model decomposes a hard turn into independent questions and issues one
 * call per question, so every fragment reads as an independent sub-agent with
 * its own progress line and result card. The turn's main model and the
 * assembled system prompt arrive through the tools context — the same unified
 * construction the main agent uses — so sub-agents never re-resolve config or
 * rebuild context on their own.
 */
export async function thinkDeepExecute(
  { question, effort = "low" }: {
    question: string;
    effort?: "low" | "medium" | "high";
  },
  { context: ctx, toolCallId }: ExecuteOpts<ToolContext>,
): Promise<ThinkDeepFragmentResult> {
  "use step";

  if (!isAIConfigured()) {
    return {
      question,
      ok: false,
      status: "error",
      error:
        "AI is not configured (no API key). Set DEEPSEEK_API_KEY or another provider key.",
    };
  }

  // The turn's main model flows through the tools context (shared with the
  // main agent — no per-call config resolution / GitHub round-trip). Falls
  // back to resolving it only when the context lacks it (e.g. loop tools).
  const modelConfig = ctx.mainModel ?? (await resolveMainModelFromConfig());

  // Step start — the fragment's adaptive SDK timeout is measured from here so
  // the step returns around STEP_TOTAL_MS no matter how long setup took.
  const stepStartMs = Date.now();

  // Single fragment (index 0 of 1) → streams WITHOUT the [i/N] prefix.
  return runThinkDeepFragment(
    { question, effort },
    0,
    1,
    {
      modelConfig,
      baseSystemPrompt: ctx.baseSystemPrompt,
      toolCallId,
      stepStartMs,
    },
  );
}

/**
 * Run ONE think-only reasoning fragment — a single bounded `streamText` call
 * (main model, thinking on) over exactly the facts embedded in its question.
 * Called once per thinkDeep call (index 0 of total 1), so its progress lines
 * carry no `[i/N]` prefix.
 */
async function runThinkDeepFragment(
  fragment: ThinkDeepFragmentInput,
  index: number,
  total: number,
  opts: {
    modelConfig: ModelConfig;
    baseSystemPrompt?: string;
    toolCallId: string;
    stepStartMs: number;
  },
): Promise<ThinkDeepFragmentResult> {
  const { question, effort = "low" } = fragment;
  const { modelConfig, baseSystemPrompt, toolCallId, stepStartMs } = opts;

  const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";

  // Thinking is always requested for a reasoning fragment; the injector owns
  // the provider-specific effort mapping.
  const providerOptions = normalizeReasoningEffort(
    modelConfig.sdk,
    modelConfig.id,
    true,
    effort,
  );
  const system = buildSubAgentSystemPrompt(baseSystemPrompt);
  const dateAnchor = new Date().toISOString().slice(0, 10);

  const userPrompt = [
    `Today is ${dateAnchor}.`,
    "",
    "# Reasoning fragment",
    "",
    "Reason through the sub-question below to a clear conclusion. Write your",
    "conclusion as you go — a hard deadline will cut you off, and every sentence",
    "you emit is preserved and returned to the caller.",
    "",
    `Sub-question: ${question.trim()}`,
    "",
    "You have no tools and no search. Reason with what is given; state plainly",
    "anything you lack.",
  ]
    .filter(Boolean)
    .join("\n");

  // Adaptive SDK timeout — the PRIMARY hook: `streamText({ timeout })` runs
  // `AbortSignal.timeout()` (available in real Node) and ABORTS the stream
  // cleanly at the deadline, surfacing as AbortError. Measured from step start
  // so every fragment in the batch shares the same wall.
  const streamTimeoutMs = Math.max(
    30_000,
    STEP_TOTAL_MS - (Date.now() - stepStartMs),
  );

  // Accumulated by onChunk — the written answer (text-delta) and the thinking
  // trail (reasoning-delta). Both are returned on completion AND interruption.
  let answer = "";
  let reasoning = "";

  // Live progress → the shared `data-tool-progress` channel. The sub-agent's
  // reasoning and answer stream token-by-token; we forward the CURRENT line
  // (text after the last newline) so the client shows a growing single line
  // that resets at line boundaries — the same flowing behavior as the thinking
  // phase. A single reused writer keeps the step reliable: creating a fresh
  // `getWritable()` pipeline per write failed silently on long fragments. The
  // client merges these chunks by (type, id = tool-<toolCallId>) into one part,
  // so the write cadence here is decoupled from delivery — the client just
  // replaces that part's data on each arrival.
  //
  // Writes are THROTTLED (see progress-throttle.ts): the getWritable() pump
  // drains only ~55-60 chunks/sec, and writing every token fire-and-forget
  // backed up a queue whose tail (the whole answer) arrived ~49s after the
  // turn rendered. Stage changes and line resets force-send immediately so the
  // thinking → answer transition and the per-line re-render stay visible.
  let progressWriter: WritableStreamDefaultWriter<UIMessageChunk> | null = null;
  let progressState: ProgressWriteState = {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
  };

  const emitLine = (line: string, stage: "thinking" | "writing") => {
    if (!progressWriter) {
      try {
        progressWriter = getWritable<UIMessageChunk>().getWriter();
      } catch {
        return;
      }
    }
    void progressWriter
      .write({
        type: "data-tool-progress",
        id: `tool-${toolCallId}`,
        data: { toolCallId, toolName: "thinkDeep", text: prefix + line, stage },
      })
      .catch(() => {});
  };

  const writeProgress = () => {
    const source = answer || reasoning;
    if (!source) return;
    const now = Date.now();
    const line = source.slice(source.lastIndexOf("\n") + 1);
    const stage: "thinking" | "writing" = answer ? "writing" : "thinking";
    if (!shouldEmitProgress(progressState, { line, stage }, now)) return;
    progressState = { lastWriteMs: now, lastLine: line, lastStage: stage, sentAny: true };
    emitLine(line, stage);
  };

  // Push the final line at step end so the box settles on the real last line
  // (the last throttled write may have been a few lines behind).
  const flushProgress = () => {
    const source = answer || reasoning;
    if (!source) return;
    const line = source.slice(source.lastIndexOf("\n") + 1);
    const stage: "thinking" | "writing" = answer ? "writing" : "thinking";
    if (
      progressState.sentAny &&
      line === progressState.lastLine &&
      stage === progressState.lastStage
    ) {
      return;
    }
    progressState = {
      lastWriteMs: Date.now(),
      lastLine: line,
      lastStage: stage,
      sentAny: true,
    };
    emitLine(line, stage);
  };

  try {
    const result = await withStepTimeout(
      async () => {
        try {
          // streamText (not generateText) so onChunk can capture BOTH channels
          // progressively — never lost, even mid-thought.
          const stream = await streamText({
            model: createModel(modelConfig),
            system,
            prompt: userPrompt,
            providerOptions,
            // The SDK timeout hook — aborts the stream cleanly at the deadline.
            timeout: streamTimeoutMs,
            onChunk({ chunk }) {
              if (chunk.type === "text-delta") {
                answer += chunk.text;
                // Stream the live reasoning/answer line to the client.
                writeProgress();
              } else if (chunk.type === "reasoning-delta") {
                reasoning += chunk.text;
                writeProgress();
              }
            },
          });
          // Provider warnings (unsupported settings, silent downgrades such as
          // dropped image parts) never throw — log them so a quiet degradation
          // is visible in the server log. Promise-only in the SDK, so attach
          // without touching the control flow.
          void Promise.resolve(stream.warnings).then((w) => {
            if (w?.length) {
              console.warn(
                `[thinkDeep] model=${modelConfig.id} stream warnings:`,
                w,
              );
            }
          });
          return await stream.text;
        } finally {
          // Push the final progress line, then release the writer so the step's
          // HTTP request can terminate (an unreleased lock keeps it alive until
          // timeout).
          try {
            flushProgress();
            progressWriter?.releaseLock();
          } catch {
            /* ignore */
          }
        }
      },
      // Backstop (fires ~3s after the SDK abort): if the abort somehow doesn't
      // surface, withStepTimeout still returns a structured result before the
      // wall — the step never dies silently. This must stay strictly under 300s
      // (plus return overhead) or the platform kill would beat it.
      streamTimeoutMs + 3_000,
      () => answer || undefined,
    );

    if (!result.ok) {
      // Backstop fired (the SDK timeout didn't surface) — same structured return.
      return {
        question,
        ok: false,
        status: "timeout",
        error: `Reasoning fragment did not finish within ${Math.round(result.elapsedMs / 1000)}s and was interrupted.`,
        answer,
        reasoning,
        note: SUB_AGENT_TIMEOUT_NOTE,
      };
    }

    return {
      question,
      ok: true,
      status: "completed",
      answer: result.result ?? "",
      reasoning,
    };
  } catch (err) {
    if (isTimeoutAbort(err)) {
      // The SDK timeout hook aborted the stream — return the partial conclusion
      // and the thinking trail.
      return {
        question,
        ok: false,
        status: "timeout",
        error: `Reasoning fragment did not finish within ${Math.round(streamTimeoutMs / 1000)}s and was interrupted.`,
        answer,
        reasoning,
        note: SUB_AGENT_TIMEOUT_NOTE,
      };
    }
    return {
      question,
      ok: false,
      status: "error",
      error: err instanceof Error ? err.message : "Sub-agent failed",
      answer: "",
      reasoning: "",
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
): Promise<{ recorded: true; step: number; done: boolean } | { error: string }> {
  "use step";

  // Demo mode safety net — startLoopExecute already blocks loops in demo,
  // but a loop agent started through another path should fail cleanly.
  if (!canWrite()) {
    return {
      error: "Loop progress cannot be recorded in demo mode. The loop should not have started.",
    };
  }

  try {
    // The GitHub/local read-append-write can hang on a network partition; a 30s
    // soft timeout bounds the checkpoint. The loop run file is the accumulator,
    // so a timed-out checkpoint is safe to retry. The abort signal stops the
    // losing work BEFORE its write — otherwise a timed-out checkpoint could
    // still commit later and duplicate the step the retry already recorded.
    const io = await withStepTimeout(
      async (signal) => {
        const existing = await readLoopRun(ctx.filePath);
        if (signal.aborted) {
          throw new Error("Checkpoint aborted after timeout — write skipped");
        }
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
          deadlineAt:
            existing?.deadlineAt ??
            new Date(Date.parse(ctx.startedAt) + LOOP_WALL_CLOCK_MS).toISOString(),
          sliceOrigin: ctx.sliceOrigin,
          tags: ctx.tags,
          iterations: steps.length,
          maxIterations: ctx.maxIterations,
          lastError: existing?.lastError ?? "",
          steps,
        };
        if (signal.aborted) {
          throw new Error("Checkpoint aborted after timeout — write skipped");
        }
        await writeLoopFile(ctx.filePath, serializeLoop(run));
        return { steps, step };
      },
      30_000,
    );
    if (!io.ok || io.result === undefined) {
      return {
        error: `Checkpoint write timed out after ${Math.round(io.elapsedMs / 1000)}s — the loop step is not recorded and will be retried.`,
      };
    }
    const { steps, step } = io.result;

    // Live progress chunk — best-effort: the memory-truth write above already
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
  } catch (err) {
    // Triage: a failed checkpoint returns as data — the loop run file is the
    // accumulator, so the model sees "couldn't checkpoint" instead of a thrown
    // error that retries a step whose work is already committed.
    if (isTransientError(err)) throw err;
    console.warn(
      `[Loop] triaged checkpoint failure (loop=${ctx.loopId}):`,
      err instanceof Error ? err.message : err,
    );
    return { error: triageErrorMessage(err, "loopReport") };
  }
}
