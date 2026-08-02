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
  continueOutputExecute,
  loopReportExecute,
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
  recentTurns: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  // The worker model config flows through the context for recall / loop calls.
  // Mirrors ModelConfig structurally so the AI SDK's inferred context type
  // stays assignable (passthrough/record would force an index signature).
  workerModel: z.object({
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
  }).optional(),
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
// The CHAT agent gets only the "pointed read" concept tools (read a slice /
// belief / cognition it was given an id for) plus the delegation tools
// (`recall` hands the actual search to the Flash recall engine; webSearch /
// startLoop / continueOutput). The exploration tools (readTimeline /
// listSlices / listStrands / readStrand) are the recall engine's job — the
// main agent does not browse memory itself.
export const chatTools = {
  readSlice: conceptTools.readSlice,
  readPreviously: conceptTools.readPreviously,
  readAgentTimeline: conceptTools.readAgentTimeline,
  recall: tool({
    description:
      "Search past conversation slices for context relevant to the current " +
      "query. Use this when you need to recall what was discussed in previous " +
      "sessions, or when the user references something you need to look up in " +
      "their history. Returns POINTERS — which slices are relevant and why " +
      "(slice ids, relevance, reasons) — not the conversation content itself. " +
      "Call readSlice (optionally with a range) to fetch the actual turns from " +
      "the slices you want to use.",
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
  continueOutput: tool({
    description:
      "Signal that your answer is not finished and you want to keep writing. " +
      "Use this for LONG or COMPLEX responses: write a section, call this " +
      "tool, then keep writing in the next step. The system keeps your " +
      "partial text in context — pick up exactly where you left off, do not " +
      "repeat. Do NOT call it once your answer is complete.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: continueOutputExecute,
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
    readPreviously: ctx,
    readAgentTimeline: ctx,
    recall: ctx,
    webSearch: ctx,
    startLoop: ctx,
    continueOutput: ctx,
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
