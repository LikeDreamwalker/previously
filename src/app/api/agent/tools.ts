/**
 * Shared tool definitions for the WorkflowAgent — chat and loop both bind
 * their tool sets here.
 *
 * Each tool couples an inputSchema (what the model provides), a contextSchema
 * (what the workflow provides via `toolsContext`), and a standalone
 * `"use step"` executor from ./tool-executors — so every tool call is an
 * individually durable, auto-retried workflow step.
 *
 * Tools are conceptual, not filesystem-oriented. The agent sees slices,
 * strands, timelines, and agent timelines — never file paths. Each tool
 * constructs its own path internally and only accesses its specific concept.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  readSliceExecute,
  readSliceSummaryExecute,
  readTimelineWindowExecute,
  listSlicesExecute,
  readTimelineExecute,
  readStrandExecute,
  listStrandsExecute,
  readAgentTimelineExecute,
  readPreviouslyExecute,
  webSearchExecute,
  webFetchExecute,
  recallExecute,
  thinkDeepExecute,
  loopReportExecute,
  type ToolContext,
  type LoopToolContext,
} from "./tool-executors";

// ─── Context schemas ─────────────────────────────────────────────────────

/** Structural ModelConfig schema for the serializable tool context — mirrors
 *  src/lib/models/registry.ts so provider configs survive the workflow
 *  boundary. Shared by workerModel (the cheap internal tier) and mainModel
 *  (the turn's resolved main agent). */
const modelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  providerName: z.string(),
  sdk: z.enum(["deepseek", "anthropic", "openai"]),
  envKey: z.string(),
  baseURL: z.string().optional(),
  capabilities: z.object({
    thinking: z.boolean(),
    vision: z.boolean(),
    maxTokens: z.number(),
  }),
  defaultThinking: z.boolean(),
  defaultEffort: z.enum(["low", "medium", "high"]),
});

const toolContextSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  useGithub: z.boolean(),
  useDemo: z.boolean(),
  sliceId: z.string(),
  recentTurns: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  // The turn's assembled system prompt, fanned out to thinkDeep so sub-agents
  // share the exact same prefix as the main agent — prompt-cache hits across
  // main + sub-agent calls within one turn. Optional: loop tool sets have none.
  baseSystemPrompt: z.string().optional(),
  // The worker model config flows through the context for recall / loop calls.
  workerModel: modelConfigSchema.optional(),
  // The turn's resolved MAIN model — thinkDeep sub-agents use it directly
  // (the same one injected for the main agent) instead of re-resolving config
  // from GitHub on every fragment step.
  mainModel: modelConfigSchema.optional(),
});

const loopToolContextSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  useGithub: z.boolean(),
  loopId: z.string(),
  goal: z.string(),
  filePath: z.string(),
  startedAt: z.string(),
  sliceOrigin: z.string().nullable(),
  tags: z.array(z.string()),
  maxIterations: z.number(),
});

// ─── Concept tools (shared by chat + loop) ──────────────────────────────

export const conceptTools = {
  readSlice: tool({
    description:
      "Read a time slice's conversation record (core timeline). " +
      "LAST RESORT for memory access — prefer readSliceSummary (cheapest: " +
      "frontmatter only) for a relevance check and readTimelineWindow (date " +
      "window of the catalog) for orientation. Reach readSlice only when you " +
      "need the actual conversation text. " +
      "Use the optional `range` parameter to fetch only specific turns instead " +
      "of the entire slice — a full slice is the most expensive option. " +
      "`search` matches keywords across the slice (misses return the full slice " +
      "with a note); `lines` reads a 1-indexed line range like a code file.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
      range: z
        .object({
          type: z
            .enum(["turns", "last", "date", "search", "lines"])
            .describe(
              "turns = specific turn indices. last = most recent N turns. " +
              "date = turns after a given timestamp. " +
              "search = keyword match, returns matching turns (+ context); " +
              "if nothing matches, returns the full slice with a note. " +
              "lines = 1-indexed line range of the raw file.",
            ),
          indices: z
            .array(z.number())
            .optional()
            .describe("Turn indices (0-based). Only for type 'turns'."),
          count: z
            .number()
            .optional()
            .describe("Number of recent turns. Only for type 'last'."),
          after: z
            .string()
            .optional()
            .describe("ISO 8601 timestamp. Only for type 'date'."),
          keywords: z
            .array(z.string())
            .optional()
            .describe("Case-insensitive keywords to match. Only for type 'search'."),
          context: z
            .number()
            .optional()
            .describe("Turns of context around each match (default 1). Only for type 'search'."),
          start: z
            .number()
            .optional()
            .describe("First line (1-indexed, inclusive). Only for type 'lines'."),
          end: z
            .number()
            .optional()
            .describe("Last line (1-indexed, inclusive). Only for type 'lines'."),
        })
        .optional()
        .describe(
          "Optional range filter. When omitted, returns the full slice content.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readSliceExecute,
  }),
  readSliceSummary: tool({
    description:
      "Read a slice's summary (frontmatter only): focus, summary, tags, tone, " +
      "turn count, open loops, decisions. The CHEAPEST way to check what a " +
      "slice is about before reading any turns. Prefer this over readSlice for " +
      "relevance checks; only read turns (readSlice with a range) when the " +
      "summary says the exact content matters.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
    }),
    contextSchema: toolContextSchema,
    execute: readSliceSummaryExecute,
  }),
  readTimelineWindow: tool({
    description:
      "Read the timeline catalog over a date window (inclusive, YYYY-MM-DD) — " +
      "one compact pointer line per slice (id · focus · tags · turns). " +
      "Use this to orient by time: 'what happened this week / last month', or " +
      "when the user references a period. A line is a pointer, not content — " +
      "open a slice with readSliceSummary / readSlice when it looks relevant.",
    inputSchema: z.object({
      from: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD (inclusive). Omit for 'from the beginning'."),
      to: z
        .string()
        .optional()
        .describe("End date YYYY-MM-DD (inclusive). Omit for 'up to now'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max slices to list (default 20)."),
    }),
    contextSchema: toolContextSchema,
    execute: readTimelineWindowExecute,
  }),
  listSlices: tool({
    description:
      "Browse time slice directories to see what slices exist. " +
      "Use this to explore available time slices for a given year and month.",
    inputSchema: z.object({
      year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Year. Defaults to the current year."),
      month: z
        .number()
        .min(1)
        .max(12)
        .optional()
        .describe("Month (1-12). Defaults to the current month."),
    }),
    contextSchema: toolContextSchema,
    execute: listSlicesExecute,
  }),
  readTimeline: tool({
    description:
      "Read a monthly timeline index — lists every slice in that month " +
      "with its focus, summary, and tags. Use this to get a high-level " +
      "overview before deciding which slices to read in full.",
    inputSchema: z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().min(1).max(12),
    }),
    contextSchema: toolContextSchema,
    execute: readTimelineExecute,
  }),
  readStrand: tool({
    description:
      "Follow a strand — a keyword tag that threads through multiple " +
      "time slices. Returns all slice paths carrying that tag. " +
      "Use this to trace a topic across time.",
    inputSchema: z.object({
      strand: z
        .string()
        .describe("The strand (tag) to follow, e.g. 'rust', 'loop-testing'."),
    }),
    contextSchema: toolContextSchema,
    execute: readStrandExecute,
  }),
  listStrands: tool({
    description:
      "List all known strands — every keyword tag that has been " +
      "woven through time slices. Use this to discover what topics exist.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: listStrandsExecute,
  }),
  readAgentTimeline: tool({
    description:
      "Read your own cognitive record (Agent timeline) for a slice — " +
      "what you were thinking, which tools you called, and why. " +
      "Use this for self-reflection: to understand your past reasoning.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format."),
    }),
    contextSchema: toolContextSchema,
    execute: readAgentTimelineExecute,
  }),
  readPreviously: tool({
    description:
      "Read the previously.md (previously.md) for a specific slice — the agent's " +
      "impressions and understanding of the user at that moment in time. " +
      "The current slice's previously.md is already in your context; use this " +
      "only to read historical versions for comparison.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .optional()
        .describe(
          "Slice ID in YYYY-MM-DD-HHMM format. Defaults to the current slice.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readPreviouslyExecute,
  }),
};

// ─── Chat tool set ───────────────────────────────────────────────────────
//
// The CHAT agent gets the granular memory tools — the cheap pointers first
// (recall / readTimelineWindow / readSliceSummary), readSlice as the last
// resort for actual text — plus readPreviously / readAgentTimeline and the
// delegation tools (`recall` hands the actual search to the Flash recall
// engine; webSearch / thinkDeep). startLoop is commented out (background loops
// disabled). The raw browse tools (listSlices / listStrands / readStrand) stay
// the recall engine's job — the main agent does not walk directories itself.
export const chatTools = {
  readSlice: conceptTools.readSlice,
  readSliceSummary: conceptTools.readSliceSummary,
  readTimelineWindow: conceptTools.readTimelineWindow,
  readPreviously: conceptTools.readPreviously,
  readAgentTimeline: conceptTools.readAgentTimeline,
  recall: tool({
    description:
      "Search past conversation slices for context relevant to the current " +
      "query. Use this when you need to recall what was discussed in previous " +
      "sessions, or when the user references something you need to look up in " +
      "their history. Returns POINTERS — which slices are relevant and why " +
      "(slice ids, relevance, reasons) — plus recommended reads with suggested " +
      "priorities. It never returns conversation content. " +
      "Timeline lines and card summaries are only enough to decide WHETHER to " +
      "dig — never enough to QUOTE. Open the slice with readSlice (optionally " +
      "with a range) before citing specifics from a past event. " +
      "If the search returns NO relevant matches, do NOT call recall again for " +
      "this topic — there is no past context to find; answer from the conversation " +
      "and your knowledge.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("What to search for in past conversations. Be specific about the topic, person, project, or question you need context on."),
    }),
    contextSchema: toolContextSchema,
    execute: recallExecute,
  }),
  webSearch: tool({
    description:
      "Search the live web for current or external information — news, " +
      "releases, prices, docs, anything time-sensitive or beyond the user's " +
      "memory. Returns a concise cited answer, source links, AND a " +
      "recommendation on what to do with the results (which sources look " +
      "strongest, what is uncertain, whether to fetch a specific page). " +
      "Do not use it for things already in memory or that you reliably know. " +
      "Read individual pages the search points to with webFetch.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("A specific, self-contained search question."),
    }),
    contextSchema: toolContextSchema,
    execute: webSearchExecute,
  }),
  webFetch: tool({
    description:
      "Fetch and return the raw text content of a specific URL. The page is " +
      "fetched server-side; scripts and styles are stripped. Returns up to " +
      "~15K characters of extracted prose. Use this to read a page the user " +
      "pasted, or to dive into a source that webSearch suggested. Do NOT use " +
      "for search — use webSearch to find things, webFetch to read a page. " +
      "Optional `range`: `search` matches keywords across the page (misses " +
      "return the full text with a note); `lines` reads a 1-indexed line range.",
    inputSchema: z.object({
      url: z
        .string()
        .describe("The full URL to fetch, e.g. 'https://example.com/article'."),
      range: z
        .object({
          type: z
            .enum(["search", "lines"])
            .describe(
              "search = keyword match, returns matching paragraphs (+ context); " +
              "if nothing matches, returns the full page text with a note. " +
              "lines = 1-indexed line range of the extracted text.",
            ),
          keywords: z
            .array(z.string())
            .optional()
            .describe("Case-insensitive keywords to match. Only for type 'search'."),
          context: z
            .number()
            .optional()
            .describe("Paragraphs of context around each match (default 1). Only for type 'search'."),
          start: z
            .number()
            .optional()
            .describe("First line (1-indexed, inclusive). Only for type 'lines'."),
          end: z
            .number()
            .optional()
            .describe("Last line (1-indexed, inclusive). Only for type 'lines'."),
        })
        .optional()
        .describe("Optional selective read. When omitted, returns the full extracted text."),
    }),
    contextSchema: toolContextSchema,
    execute: webFetchExecute,
  }),
  // NOTE(startLoop-disabled): background loops are temporarily disabled — the
  // loop capability is still being stabilized. The definition is commented out
  // so the agent no longer sees the tool. Re-enable by uncommenting it here
  // and restoring `startLoop` to buildChatToolsContext.
  // startLoop: tool({
  //   description:
  //     "Start a durable background loop that works a goal over multiple steps " +
  //     "on its own and records its progress to memory/loops. Use this when the " +
  //     "user explicitly asks to run something in the background or continuously, " +
  //     "OR when you judge a task is large or long-running enough that it is " +
  //     "better worked autonomously than answered inline. Tell the user you have " +
  //     "started one.",
  //   inputSchema: z.object({
  //     goal: z
  //       .string()
  //       .describe("A clear, self-contained statement of what the loop should accomplish."),
  //     tags: z
  //       .array(z.string())
  //       .optional()
  //       .describe("Keyword tags for later recall, e.g. topic names."),
  //   }),
  //   contextSchema: toolContextSchema,
  //   execute: startLoopExecute,
  // }),
  thinkDeep: tool({
    description:
      "Dispatch ONE reasoning fragment — a small, self-contained logical " +
      "question reasoned through independently by a think-only copy of yourself " +
      "(no search, no memory tools — embed every fact it needs in the question). " +
      "Returns the conclusion plus its thinking trail. " +
      "DEFAULT behavior: at the start of a substantive turn, decompose the user's " +
      "question into its independent threads and dispatch each as its OWN " +
      "thinkDeep call BEFORE writing your answer — do not wait for the user to " +
      "ask, and do not reason through a multi-angle question monolithically " +
      "(that is what times out). Verify a claim, weigh a trade-off, poke holes " +
      "in a position, answer a sub-question. Only skip it for genuinely " +
      "single-threaded turns: a simple fact you already hold, a routine " +
      "acknowledgment, an emotionally-engaged support turn, or a recall from " +
      "memory. Embed ALL facts the fragment needs in the question — the " +
      "sub-agent cannot search or read memory. Tag each fragment with the right " +
      "effort: low for simple logical verification, medium for a comparison, " +
      "high for deep structural analysis. A fragment may come back partial " +
      "(`status: timeout`) — its `answer` and `reasoning` hold what it already " +
      "produced; work with them, or gather the missing facts yourself and " +
      "dispatch a finer fragment. Synthesize the fragments into your answer in " +
      "your own voice.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("Self-contained sub-question for the reasoning fragment. Include all necessary context and facts — the sub-agent has no tools and cannot look anything up."),
      effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Reasoning intensity: 'low' for simple logical verification (fast), 'medium' for a comparison, 'high' for deep analysis. Defaults to 'low'."),
    }),
    contextSchema: toolContextSchema,
    execute: thinkDeepExecute,
  }),
};

// ─── Loop tool set ───────────────────────────────────────────────────────

export const loopTools = {
  ...conceptTools,
  loopReport: tool({
    description:
      "Report one completed increment of work toward the goal. Call this " +
      "exactly once after each meaningful step: what you did (action), what " +
      "came out of it (result), and whether the goal is now fully accomplished " +
      "(done). Set done=true only when the goal is genuinely complete.",
    inputSchema: z.object({
      action: z.string().describe("What you did this step, in one line."),
      result: z.string().describe("The outcome or reasoning produced this step."),
      done: z.boolean().describe("True only if the goal is fully accomplished."),
    }),
    contextSchema: loopToolContextSchema,
    execute: loopReportExecute,
  }),
};

// ─── toolsContext builders ───────────────────────────────────────────────

/** Same serializable chat context, fanned out to every chat tool by name. */
export function buildChatToolsContext(ctx: ToolContext): Record<keyof typeof chatTools, ToolContext> {
  return {
    readSlice: ctx,
    readSliceSummary: ctx,
    readTimelineWindow: ctx,
    readPreviously: ctx,
    readAgentTimeline: ctx,
    recall: ctx,
    webSearch: ctx,
    webFetch: ctx,
    thinkDeep: ctx,
  };
}

/** Concept tools share the chat-shaped context; loopReport gets the loop identity. */
export function buildLoopToolsContext(
  memoryCtx: ToolContext,
  loopCtx: LoopToolContext,
): Record<keyof typeof conceptTools, ToolContext> & { loopReport: LoopToolContext } {
  return {
    readSlice: memoryCtx,
    readSliceSummary: memoryCtx,
    readTimelineWindow: memoryCtx,
    listSlices: memoryCtx,
    readTimeline: memoryCtx,
    readStrand: memoryCtx,
    listStrands: memoryCtx,
    readAgentTimeline: memoryCtx,
    readPreviously: memoryCtx,
    loopReport: loopCtx,
  };
}

