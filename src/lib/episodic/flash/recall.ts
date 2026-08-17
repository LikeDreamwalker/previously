/**
 * Flash Recall Search — a mini-agent that Pro calls to search past conversations.
 *
 * This is NOT a workflow step. It runs inside a single WorkflowAgent tool call
 * (recallExecute in tool-executors.ts). The sub-agent uses generateText with
 * maxSteps to do a focused exploration: global timeline → check strands → deep-read
 * slices → structured report.
 *
 * Flash ONLY returns pointers (which slices, which turns, why relevant).
 * The EXECUTOR passes those pointers straight back to Pro, which then calls
 * readSlice for any content it wants. Flash never produces semantic summaries
 * of episodic content.
 */

import { generateText, tool, isStepCount } from "ai";
import { z } from "zod";
import { tolerantBounded01 } from "@/lib/chat/tolerant-schemas";
import { fsReadFile } from "../io-helpers";
import { readStrands } from "@/lib/episodic/manager";
import { generateGlobalTimeline } from "@/lib/episodic/flash/global-timeline";
import { sliceLine } from "@/lib/episodic/timeline/render";
import { TIMELINE_INDEX_PATH } from "@/lib/episodic/timeline/store";
import type { TimelineIndex, TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { createModel } from "@/lib/models/provider";
import { workerProviderOptions } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";

// ─── Types ──────────────────────────────────────────────────────────────

export interface RecallHit {
  slice_id: string;
  relevance: number;
  reason: string;
}

/** A slice the main agent should consider reading, with a suggested priority. */
export interface RecommendedRead {
  slice_id: string;
  priority: "high" | "medium" | "low";
  reason: string;
  note?: string;
}

/** A raw recommended_reads entry straight from the model's recallReport input. */
interface RawRecommendedRead {
  slice_id?: unknown;
  priority?: unknown;
  reason?: unknown;
  note?: unknown;
}

/**
 * Normalize the model's `recommended_reads` array into `RecommendedRead[]`.
 * Drops entries without a usable slice_id, defaults priority to "medium",
 * and caps at 5 — the main agent should not be handed a wall of suggestions.
 */
export function normalizeRecommendedReads(
  raw: RawRecommendedRead[] | undefined,
): RecommendedRead[] {
  return (raw ?? [])
    .filter((r): r is RawRecommendedRead & { slice_id: string } => {
      return (
        r !== null &&
        typeof r === "object" &&
        typeof r.slice_id === "string" &&
        r.slice_id.length > 0
      );
    })
    .slice(0, 5)
    .map((r) => ({
      slice_id: r.slice_id,
      priority:
        r.priority === "high" || r.priority === "low" ? r.priority : "medium",
      reason: typeof r.reason === "string" ? r.reason : "",
      note: typeof r.note === "string" && r.note.length > 0 ? r.note : undefined,
    }));
}

/**
 * Drop any hit / recommended read whose slice is the current (ongoing)
 * conversation. The current slice is where the query is being asked — it is
 * NOT a past memory, so it must never surface as a recall result, regardless
 * of how the model saw it (timeline entry, strand path, …).
 */
export function excludeCurrentSlice<T extends { slice_id: string }>(
  items: T[],
  currentSliceId: string,
): T[] {
  if (!currentSliceId) return items;
  return items.filter((i) => i.slice_id !== currentSliceId);
}

export interface RecallSearchOutput {
  hits: RecallHit[];
  confidence: number;
  reasoning: string;
  /** Slices worth opening with readSlice — the recall agent's advisory output. */
  recommendedReads: RecommendedRead[];
}

export interface RecallSearchInput {
  query: string;
  /** The ongoing session's slice — must NEVER appear in recall results. */
  currentSliceId: string;
  owner: string;
  repo: string;
  useGithub: boolean;
  useDemo: boolean;
  /** Available strands (keyword tag → slice paths). Flash auto-traces matching ones. */
  strandsContext?: Record<string, string[]>;
  /** The worker model to run the recall search on (resolved from config). */
  model: ModelConfig;
  /** Live exploration callback — fired as the sub-agent starts each tool, so
   *  the caller can stream real progress ("Reading global timeline…",
   *  "Tracing strand X…") instead of a static status line. */
  onProgress?: (text: string) => void;
}

// ─── Global timeline path ──────────────────────────────────────────────

const GLOBAL_TIMELINE_PATH = "memory/episodic/timeline.md";

// ─── Sub-agent tool: readGlobalTimeline ────────────────────────────────

const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

/** How many pointer lines readGlobalTimeline returns. The full projection
 *  (100+ slices and growing) is too large to dump into the worker model in
 *  one tool result — it burns steps and context. Older slices are reachable
 *  via readTimelineWindow. */
const TIMELINE_PAGE_SIZE = 40;

/** True when an ISO timestamp is parseable and older than the staleness threshold. */
function isStaleTimestamp(iso: string | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t > STALE_THRESHOLD_MS;
}

/** Render the newest `limit` catalog entries as pointer lines (newest first),
 *  with a header noting the total and how to reach older slices. */
export function paginateTimelineEntries(
  slices: TimelineSliceEntry[],
  limit: number = TIMELINE_PAGE_SIZE,
): string {
  const newest = [...slices]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, limit);
  if (newest.length === 0) {
    return "(timeline is empty — no slices yet)";
  }
  const header =
    `Global timeline: showing newest ${newest.length} of ${slices.length} slices. ` +
    "Older slices: use readTimelineWindow with a date range.";
  return `${header}\n${newest.map(sliceLine).join("\n")}`;
}

/** Same pagination for the markdown projection — the fallback when
 *  index.json is missing. timeline.md is rendered newest-first, so the first
 *  pointer lines (`- **id** …`) are already the newest slices. */
export function paginateTimelineMarkdown(
  content: string,
  limit: number = TIMELINE_PAGE_SIZE,
): string {
  const pointerLines = content.split("\n").filter((l) => l.startsWith("- **"));
  if (pointerLines.length === 0) {
    return "(timeline is empty — no slices yet)";
  }
  const page = pointerLines.slice(0, limit);
  const header =
    `Global timeline: showing newest ${page.length} of ${pointerLines.length} slices. ` +
    "Older slices: use readTimelineWindow with a date range.";
  return `${header}\n${page.join("\n")}`;
}

/** Regenerate the projection, then return the paginated view. */
async function regenerateAndPaginate(): Promise<string> {
  // generateGlobalTimeline reweaves both index.json and timeline.md.
  await generateGlobalTimeline();
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as Partial<TimelineIndex>;
    return paginateTimelineEntries(idx.slices ?? []);
  } catch {
    const content = await fsReadFile(GLOBAL_TIMELINE_PATH);
    return paginateTimelineMarkdown(content);
  }
}

async function readGlobalTimelineImpl(): Promise<string> {
  // Preferred path: the structured catalog, paginated to the newest slices.
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as Partial<TimelineIndex>;
    // Defense in depth: regenerate when the catalog is stale — the recall
    // agent would miss recent slices otherwise.
    if (isStaleTimestamp(idx.updated_at)) {
      console.log(
        `[Recall] Global timeline stale (${Math.round((Date.now() - new Date(idx.updated_at!).getTime()) / 3_600_000)}h old), regenerating...`,
      );
      return await regenerateAndPaginate();
    }
    return paginateTimelineEntries(idx.slices ?? []);
  } catch {
    // Index missing or corrupt — fall back to the markdown projection.
  }

  try {
    const content = await fsReadFile(GLOBAL_TIMELINE_PATH);
    if (content.trim()) {
      const match = content.match(/_Generated: ([^\n]+)_/);
      if (match && isStaleTimestamp(match[1])) {
        console.log(
          `[Recall] Global timeline stale (${Math.round((Date.now() - new Date(match[1]).getTime()) / 3_600_000)}h old), regenerating...`,
        );
        return await regenerateAndPaginate();
      }
      return paginateTimelineMarkdown(content);
    }
    // File exists but is empty — regenerate
    return await regenerateAndPaginate();
  } catch {
    // File doesn't exist yet — generate it from the catalog
    try {
      return await regenerateAndPaginate();
    } catch {
      return "(No timeline index found and could not generate one. This may be the first session.)";
    }
  }
}

// ─── Sub-agent tool: readStrand ───────────────────────────────────────

async function readStrandImpl(strand: string): Promise<string> {
  try {
    const strands = await readStrands();
    const paths = strands[strand];
    if (!paths || paths.length === 0) {
      return `Strand "${strand}" not found. No slices carry this tag.`;
    }
    return `Strand "${strand}" appears in: ${paths.slice(0, 20).join(", ")}`;
  } catch {
    return `Could not read strands index.`;
  }
}

// ─── Sub-agent tool: readTimelineWindow ────────────────────────────────

/** Timeline catalog over a date window (inclusive YYYY-MM-DD) — compact
 *  pointer lines. Lets recall navigate by TIME ("what happened in 2025-03 to
 *  2025-10") in addition to tracing strands by topic. */
async function readTimelineWindowImpl(from?: string, to?: string): Promise<string> {
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as { slices?: TimelineSliceEntry[] };
    const slices = (idx.slices ?? [])
      .filter((s) => {
        const date = s.id.slice(0, 10); // "YYYY-MM-DD"
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      })
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, 40);
    if (slices.length === 0) {
      return `(no slices in window ${from ?? "start"} → ${to ?? "now"})`;
    }
    return `Timeline ${from ?? "start"} → ${to ?? "now"} (${slices.length} slices):\n${slices.map(sliceLine).join("\n")}`;
  } catch {
    return "(timeline index not available yet — the weave hasn't run)";
  }
}

// ─── Structured output schema: recallReport ─────────────────────────

const recallReportSchema = tool({
  description:
    "Report your recall findings. Call this ONCE you have gathered enough context.",
  inputSchema: z.object({
    hits: z
      .array(
        z.object({
          slice_id: z
            .string()
            .describe("Slice ID in YYYY-MM-DD-HHMM format"),
          relevance: tolerantBounded01
            .describe("How relevant this slice is to the query, 0-1"),
          reason: z
            .string()
            .describe("One-line explanation of why this slice is relevant"),
        }),
      )
      .describe("Relevant slices found. Empty if nothing matches."),

    confidence: tolerantBounded01
      .describe("Your confidence in the completeness of this recall, 0-1"),

    reasoning: z
      .string()
      .describe("Brief explanation of your search strategy and what you found"),

    recommended_reads: z
      .array(
        z.object({
          slice_id: z
            .string()
            .describe("Slice ID in YYYY-MM-DD-HHMM format"),
          priority: z
            .enum(["high", "medium", "low"])
            .describe("How strongly you recommend the main agent read this slice."),
          reason: z
            .string()
            .describe("One line: why this slice is worth reading for the query."),
          note: z
            .string()
            .optional()
            .describe("Optional: what to look for inside the slice, if you can tell from its summary."),
        }),
      )
      .max(5)
      .describe(
        "Slices the main agent should consider opening with readSlice. " +
        "You did NOT read these slices' content — base this on the timeline summary, " +
        "strand overlap, and tag relevance. Rank by likely usefulness.",
      ),
  }),
});

// ─── Agent setup ──────────────────────────────────────────────────────

const RECALL_SYSTEM_PROMPT = `You are the recall search engine for a personal AI platform.
Your job: find past conversations relevant to a search query and advise the main agent on what to read.

You work from POINTERS ONLY — the timeline holds one compact line per slice (id · focus · tags · turns). You NEVER read slice content (no readSlice tool). Your value is fast, accurate navigation over the memory index.

Process:
1. Read the global timeline index to see all available past conversations with their pointer lines.
2. If the query is about a time period, use readTimelineWindow to scope that window.
3. If a topic seems relevant, use readStrand to trace it across slices — the strand maps a keyword to its slice paths.
4. When you have enough information, call recallReport with:
   - hits: slices with a clear connection to the query (with a one-line reason).
   - recommended_reads: slices the main agent should consider opening with readSlice — the slices whose summaries suggest the deepest or most direct relevance. The main agent decides whether to read them; you only advise.

Guidelines:
- Be thorough but efficient — aim for 2-4 steps.
- Base relevance and priority on summary quality, strand overlap, and tag relevance — not on content you never read.
- If nothing is relevant, return an empty hits array. That's fine.
- Focus on RECALLING context, not answering the question.
- The current session's slice is the ONGOING conversation, NOT a past memory — never return it as a hit or recommended read, even if it appears in the timeline or a strand path. You recall the PAST only.`;

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Step budget for the recall mini-agent. The prescribed process is 4 phases
 * (timeline → window → strand → report) and the prompt still says "aim for
 * 2-4 steps", but a wandering model gets room to explore — prepareRecallStep
 * guarantees the last step is the report.
 */
export const MAX_STEPS = 8;

/**
 * prepareStep for the recall mini-agent: when the step budget is nearly
 * exhausted and recallReport hasn't been called yet, force the model to call
 * it. Without this, an over-exploring model hits the step cap mid-exploration
 * and the run falls back to returning a partial-thinking fragment as the
 * reasoning. Pure — takes the executed steps and returns a per-step override.
 */
export function prepareRecallStep({
  steps,
  maxSteps = MAX_STEPS,
}: {
  steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName: string }> }>;
  maxSteps?: number;
}): { toolChoice: { type: "tool"; toolName: "recallReport" } } | undefined {
  const reportCalled = steps.some((s) =>
    (s.toolCalls ?? []).some((tc) => tc.toolName === "recallReport"),
  );
  if (!reportCalled && steps.length >= maxSteps - 1) {
    return { toolChoice: { type: "tool", toolName: "recallReport" } };
  }
  return undefined;
}

/**
 * Drop hits / recommended reads whose slice id is not in the catalog — the
 * worker model sometimes hallucinates plausible-looking ids, which then 404
 * when the main agent calls readSlice. `validIds === null` means the catalog
 * couldn't be loaded this run: skip validation rather than break recall.
 */
export function filterKnownSliceIds<T extends { slice_id: string }>(
  items: T[],
  validIds: ReadonlySet<string> | null,
): T[] {
  if (!validIds) return items;
  return items.filter((i) => {
    if (validIds.has(i.slice_id)) return true;
    console.warn(`[Recall] Dropping hallucinated slice id: ${i.slice_id}`);
    return false;
  });
}

/** Load the catalog's slice ids once per run. Null when unreadable. */
async function loadValidSliceIds(): Promise<Set<string> | null> {
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as Partial<TimelineIndex>;
    return new Set((idx.slices ?? []).map((s) => s.id));
  } catch {
    return null;
  }
}

/**
 * Run the recall search mini-agent using AI SDK v7 native multi-step.
 *
 * `stopWhen: isStepCount(MAX_STEPS)` tells generateText to loop: after each
 * tool call, feed the result back to the model and continue, up to MAX_STEPS
 * turns. This gives Flash time to explore (timeline → strands → deep-read)
 * and then call recallReport. `prepareStep` forces recallReport on the final
 * step if the model hasn't called it yet, so a report is always produced.
 */
export async function runRecallSearch(
  input: RecallSearchInput,
): Promise<RecallSearchOutput> {
  const { query, currentSliceId, strandsContext, onProgress } = input;

  const strandsHint = strandsContext && Object.keys(strandsContext).length > 0
    ? `
Available strands (keyword tags threaded across slices): ${Object.keys(strandsContext).join(", ")}
IMPORTANT: After reading the global timeline, check which strands match your query. Use readStrand to trace matching strands — they give you a direct path to relevant slices.`
    : "";

  const userPrompt = `Search query: "${query}"

Current slice: ${currentSliceId} — this is the ONGOING conversation, NOT a past memory. EXCLUDE it from hits and recommended_reads; only report past slices.${strandsHint}

Follow this process:
1. START — call readGlobalTimeline to see all available past conversations and their pointer lines.
2. SCOPE — if the query names a time period, call readTimelineWindow to scope that window.
3. EXPLORE — trace any matching strands with readStrand to find which slices carry the topic.
4. REPORT — call recallReport with your findings, including recommended_reads advising the main agent which slices are worth opening.

IMPORTANT: You MUST end by calling recallReport. Even if nothing matches, call it with an empty hits array.`;

  // Load the catalog's slice ids once per run — used afterwards to drop
  // hallucinated pointers before they reach the main agent.
  const validSliceIds = await loadValidSliceIds();

  try {
    const result = await generateText({
      model: createModel(input.model),
      system: RECALL_SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0.1,
      tools: {
        readGlobalTimeline: tool({
          description:
            "Read the global timeline index — pointer lines for the newest " +
            "conversation slices (with the total count). Always start here to " +
            "see what's available; use readTimelineWindow to reach older slices.",
          inputSchema: z.object({}),
          execute: async () => readGlobalTimelineImpl(),
        }),
        readStrand: tool({
          description:
            "Follow a strand (keyword tag) that threads through multiple time slices. " +
            "Returns all slice paths carrying that tag. Use this to trace a topic across time.",
          inputSchema: z.object({
            strand: z.string().describe("The strand (tag) to follow."),
          }),
          execute: async ({ strand }: { strand: string }) => {
            const content = await readStrandImpl(strand);
            return content;
          },
        }),
        readTimelineWindow: tool({
          description:
            "Read the timeline catalog over a date window (inclusive, YYYY-MM-DD) — " +
            "one compact pointer line per slice. Use this when the query is about " +
            "a time period ('what happened around mid-2025') to scope the search.",
          inputSchema: z.object({
            from: z
              .string()
              .optional()
              .describe("Start date YYYY-MM-DD (inclusive). Omit for the beginning."),
            to: z
              .string()
              .optional()
              .describe("End date YYYY-MM-DD (inclusive). Omit for now."),
          }),
          execute: async ({ from, to }: { from?: string; to?: string }) =>
            readTimelineWindowImpl(from, to),
        }),
        recallReport: recallReportSchema,
      },
      // Stream the sub-agent's exploration trail live: each tool the recall
      // engine starts surfaces as a progress line to the caller (which feeds
      // it into the data-tool-progress channel). Throttle-free — tool steps
      // are discrete ~1-5Hz events, far under the 40ms write throttle.
      onToolExecutionStart: ({ toolCall }) => {
        if (!onProgress) return;
        const name = toolCall.toolName;
        if (name === "readGlobalTimeline") {
          onProgress("Reading global timeline…");
        } else if (name === "readTimelineWindow") {
          onProgress("Scoping timeline window…");
        } else if (name === "readStrand") {
          const strand =
            typeof toolCall.input === "object" &&
            toolCall.input !== null &&
            "strand" in toolCall.input
              ? String((toolCall.input as { strand?: unknown }).strand ?? "")
              : "";
          onProgress(strand ? `Tracing strand: ${strand}…` : "Tracing a strand…");
        } else if (name === "recallReport") {
          onProgress("Compiling recall report…");
        }
      },
      toolChoice: "auto",
      stopWhen: isStepCount(MAX_STEPS),
      // Last-resort guarantee: if the model burned the budget exploring
      // without reporting, force recallReport on the final step.
      prepareStep: prepareRecallStep,
      providerOptions: workerProviderOptions(input.model.sdk),
    });

    // Extract the recallReport tool call
    const toolCalls = (result.toolCalls ?? []) as Array<{
      toolName: string;
      input: unknown;
    }>;

    for (const tc of toolCalls) {
      if (tc.toolName === "recallReport") {
        const report = tc.input as {
          hits?: RecallHit[];
          confidence?: number;
          reasoning?: string;
          recommended_reads?: Array<{
            slice_id: string;
            priority?: "high" | "medium" | "low";
            reason?: string;
            note?: string;
          }>;
        };
        const rawHits = report.hits ?? [];
        const pastHits = excludeCurrentSlice(rawHits, currentSliceId);
        const hits = filterKnownSliceIds(pastHits, validSliceIds);
        const recommendedReads = filterKnownSliceIds(
          excludeCurrentSlice(
            normalizeRecommendedReads(report.recommended_reads),
            currentSliceId,
          ),
          validSliceIds,
        );
        // If the model's only "evidence" was the current slice, the search
        // genuinely found nothing from the past — zero the confidence rather
        // than report a false hit with a confident score.
        const droppedCurrent = rawHits.length - pastHits.length;
        const confidence =
          droppedCurrent > 0 && hits.length === 0
            ? 0
            : report.confidence ?? 0.5;
        const reasoning =
          droppedCurrent > 0
            ? `${
                report.reasoning ?? ""
              } [Excluded current slice ${currentSliceId} — the ongoing conversation is not a past memory.]`.trim()
            : report.reasoning ?? "";

        console.log(
          `[Recall] Found ${hits.length} hits (${droppedCurrent} current-slice excluded), ${recommendedReads.length} recommended reads, confidence=${confidence.toFixed(2)}`,
        );
        return { hits, confidence, reasoning, recommendedReads };
      }
    }

    // recallReport not called — model may have produced text instead
    console.warn(
      "[Recall] recallReport not called. Final text:",
      result.text?.slice(0, 200) ?? "(no text)",
    );
    return {
      hits: [],
      confidence: 0,
      reasoning: result.text
        ? `Model responded without calling recallReport: ${result.text.slice(0, 200)}`
        : "Model did not call recallReport",
      recommendedReads: [],
    };
  } catch (err) {
    console.warn(
      "[Recall] Search failed, returning empty:",
      err instanceof Error ? err.message : err,
    );
    return {
      hits: [],
      confidence: 0,
      reasoning: `Recall search failed: ${err instanceof Error ? err.message : "unknown error"}`,
      recommendedReads: [],
    };
  }
}
