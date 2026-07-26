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
  listSlicesExecute,
  readTimelineExecute,
  readStrandExecute,
  listStrandsExecute,
  readAgentTimelineExecute,
  readPreviouslyExecute,
  webSearchExecute,
  recallExecute,
  startLoopExecute,
  loopReportExecute,
  updatePreviouslyExecute,
  type ToolContext,
  type LoopToolContext,
} from "./tool-executors";

// ─── Context schemas ─────────────────────────────────────────────────────

const toolContextSchema = z.object({
  repo: z.string(),
  owner: z.string(),
  useGithub: z.boolean(),
  useDemo: z.boolean(),
  sliceId: z.string(),
  closedSliceId: z.string().optional(),
  recentTurns: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
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
      "Use this when you need to see the full detail of a specific time slice " +
      "that Flash surfaced in its recall summary. " +
      "Use the optional `range` parameter to fetch only specific turns instead " +
      "of the entire slice — saves context.",
    inputSchema: z.object({
      sliceId: z
        .string()
        .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
      range: z
        .object({
          type: z
            .enum(["turns", "last", "date"])
            .describe(
              "turns = specific turn indices. last = most recent N turns. " +
              "date = turns after a given timestamp.",
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
        })
        .optional()
        .describe(
          "Optional range filter. When omitted, returns the full slice content.",
        ),
    }),
    contextSchema: toolContextSchema,
    execute: readSliceExecute,
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
      "Follow a strand (线索) — a keyword tag that threads through multiple " +
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
      "List all known strands (线索) — every keyword tag that has been " +
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
      "Read the 前情提要 (previously.md) for a specific slice — the agent's " +
      "impressions and understanding of the user at that moment in time. " +
      "The current slice's 前情提要 is already in your context; use this " +
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

export const chatTools = {
  ...conceptTools,
  recall: tool({
    description:
      "Search past conversation slices for context relevant to the current " +
      "query. Use this when you need to recall what was discussed in previous " +
      "sessions, or when the user references something you need to look up in " +
      "their history. Returns raw conversation content from matching slices — " +
      "no summaries, just the original conversations.",
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
      "memory. Returns a concise cited answer plus source links. " +
      "Do not use it for things already in memory or that you reliably know.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("A specific, self-contained search question."),
    }),
    contextSchema: toolContextSchema,
    execute: webSearchExecute,
  }),
  startLoop: tool({
    description:
      "Start a durable background loop that works a goal over multiple steps " +
      "on its own and records its progress to memory/loops. Use this when the " +
      "user explicitly asks to run something in the background or continuously, " +
      "OR when you judge a task is large or long-running enough that it is " +
      "better worked autonomously than answered inline. Tell the user you have " +
      "started one.",
    inputSchema: z.object({
      goal: z
        .string()
        .describe("A clear, self-contained statement of what the loop should accomplish."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Keyword tags for later recall, e.g. topic names."),
    }),
    contextSchema: toolContextSchema,
    execute: startLoopExecute,
  }),
  updatePreviously: tool({
    description:
      "Ask the Previously Agent (your 'brain') to review and update your " +
      "self-model (previously.md). Call this when you notice something worth " +
      "remembering about the user, when the user corrects you, or when a " +
      "time slice just closed (good time for a deep review). " +
      "This runs synchronously but the updated model is available next turn. " +
      "You do NOT need to call this every turn — only when you have a reason.",
    inputSchema: z.object({
      signal: z
        .enum(["new_observation", "user_correction", "slice_closed", "self_reflection"])
        .describe(
          "Why you're updating: new_observation (noticed something about the user), " +
          "user_correction (user said you were wrong), " +
          "slice_closed (a time slice just closed — deep review), " +
          "self_reflection (you think your strategy needs adjustment).",
        ),
      note: z
        .string()
        .optional()
        .describe("One sentence describing what triggered this. E.g. '用户说我回答太啰嗦了'."),
      priority: z
        .enum(["normal", "high"])
        .optional()
        .default("normal")
        .describe("high = user explicitly requested. normal = agent-driven observation."),
    }),
    contextSchema: toolContextSchema,
    execute: updatePreviouslyExecute,
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
    listSlices: ctx,
    readTimeline: ctx,
    readStrand: ctx,
    listStrands: ctx,
    readAgentTimeline: ctx,
    readPreviously: ctx,
    recall: ctx,
    webSearch: ctx,
    startLoop: ctx,
    updatePreviously: ctx,
  };
}

/** Concept tools share the chat-shaped context; loopReport gets the loop identity. */
export function buildLoopToolsContext(
  memoryCtx: ToolContext,
  loopCtx: LoopToolContext,
): Record<keyof typeof conceptTools, ToolContext> & { loopReport: LoopToolContext } {
  return {
    readSlice: memoryCtx,
    listSlices: memoryCtx,
    readTimeline: memoryCtx,
    readStrand: memoryCtx,
    listStrands: memoryCtx,
    readAgentTimeline: memoryCtx,
    readPreviously: memoryCtx,
    loopReport: loopCtx,
  };
}
