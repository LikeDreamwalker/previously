/**
 * Shared tool definitions for the WorkflowAgent — the chat agent binds its
 * tool set here.
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
import { isClientMode } from "@/lib/mode";
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
  recallExecute,
  thinkDeepExecute,
  currentTimeExecute,
  delegateTaskExecute,
  type ToolContext,
} from "./tool-executors";

// ─── Context schemas ─────────────────────────────────────────────────────

/** Structural ModelConfig schema for the serializable tool context — mirrors
 *  src/lib/models/registry.ts so provider configs survive the workflow
 *  boundary. Used by mainModel (the turn's resolved main agent, which all
 *  sub-agents run on since the v0.9 unified runner). */
const modelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  providerName: z.string(),
  sdk: z.enum(["deepseek", "anthropic", "openai", "bridge"]),
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

/**
 * The serializable per-turn tool context. EVERY ToolContext field must be
 * declared here: the workflow step boundary re-parses each tool's context
 * entry through this schema and zod strips undeclared keys — an undeclared
 * field silently never reaches the executor (timezone once fell off this
 * way, and every read tool rendered UTC).
 * Exported for the round-trip regression test.
 */
export const toolContextSchema = z.object({
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
  // main + sub-agent calls within one turn.
  baseSystemPrompt: z.string().optional(),
  // The turn's resolved MAIN model — all sub-agents (thinkDeep, recall, …)
  // use it directly (the same one injected for the main agent) instead of
  // re-resolving config from GitHub on every fragment step.
  mainModel: modelConfigSchema.optional(),
  // User-local time rendering (time-localize.ts / the currentTime executor).
  // These MUST be declared here: the workflow step boundary re-parses the
  // context through this schema and zod strips undeclared keys — without
  // them the executors see `timezone: undefined` and fall back to UTC.
  /** The user's IANA timezone (e.g. "Asia/Shanghai"). */
  timezone: z.string().optional(),
  /** The turn's start instant (UTC ISO) — anchors local-time rendering. */
  startedAtIso: z.string().optional(),
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale: z.string().optional(),
});

// ─── Concept tools ───────────────────────────────────────────────────────

export const conceptTools = {
  readSlice: tool({
    description:
      "Open a time slice's original conversation record (core timeline). " +
      "VERIFICATION CHANNEL ONLY — past memory is recall's job: ask it in " +
      "natural language and it reads the slices for you. Open a slice " +
      "yourself only to verify one of recall's references or when you need " +
      "the verbatim original text. " +
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
// The CHAT agent's surface is deliberately narrow (v1.0 sub-agent refinement):
// the granular memory-browse and page-fetch tools moved DOWN into the
// sub-agents — recall (an episodic-recall colleague that reads slices itself)
// and webSearch (a researcher that fetches pages itself). The main agent keeps
// readSlice as the VERIFICATION channel (audit a recall reference against the
// original text), readPreviously for the card history, and the delegation
// entries (recall / webSearch / thinkDeep). The removed tools
// (readSliceSummary / readTimelineWindow / readAgentTimeline / webFetch) stay
// defined in conceptTools / tool-executors for the sub-agent side.
export const chatTools = {
  readSlice: conceptTools.readSlice,
  readPreviously: conceptTools.readPreviously,
  currentTime: tool({
    description:
      "Check the current time — the user's local time (minute precision, with " +
      "timezone and UTC offset), how long this conversation slice has been " +
      "running and how much of its time cap is left, plus a refreshed " +
      "date-anchor table (today / tomorrow / last week with weekdays). " +
      "Call this whenever a precise time matters: \"now\", \"in a few minutes\", " +
      "\"how long have we been talking\", \"tonight\", or something due today. " +
      "The slice-start time in your system prompt is a snapshot taken when " +
      "this slice began — it may already be tens of minutes old, so never " +
      "trust it for exact times.",
    inputSchema: z.object({}),
    contextSchema: toolContextSchema,
    execute: currentTimeExecute,
  }),
  recall: tool({
    description:
      "Ask the recall colleague — a sub-agent who REMEMBERS your past " +
      "conversations with the user. Ask in natural language, colleague to " +
      "colleague (\"Did we ever talk with the user about apples?\", \"Do you " +
      "remember when they found that job?\"). Refer to the user in the THIRD " +
      "PERSON in your question — the colleague is not the user, and it " +
      "describes the user back to you in the third person too. It reads the " +
      "answers in natural language; every situational claim in its answer " +
      "carries a reference with a VERBATIM quote and the slice id — those " +
      "references are attached for your audit. An honest \"we haven't talked " +
      "about this\" is a valid, definitive answer: when it says so, do NOT " +
      "call recall again for the same topic. Open a slice yourself (readSlice) " +
      "only when you need to verify one of its references or need more of the " +
      "original text.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("A natural-language question about past conversations, asked colleague to colleague. Be specific about the topic, person, event, or period you are asking about."),
    }),
    contextSchema: toolContextSchema,
    execute: recallExecute,
  }),
  webSearch: tool({
    description:
      "Hand a research question to the web-research colleague — a sub-agent " +
      "that searches the live web AND reads the most promising pages itself, " +
      "then returns a real answer that combines what it found with its own " +
      "knowledge (web claims carry source mentions), plus its confidence " +
      "assessment (what is solid, what is uncertain or conflicting) and a few " +
      "suggested pages for your own follow-up. Use it for current or external " +
      "information — news, releases, prices, docs, anything time-sensitive or " +
      "beyond the user's memory. Do not use it for things already in memory " +
      "or that you reliably know.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("A specific, self-contained research question."),
    }),
    contextSchema: toolContextSchema,
    execute: webSearchExecute,
  }),
  thinkDeep: tool({
    description:
      "Dispatch a question to a clean-room thinking pod — a think-only copy " +
      "of yourself reasoning in complete isolation from your current context " +
      "(no search, no memory tools — embed every fact it needs in the " +
      "question). Its primary use is DECOMPOSITION: when the user raises " +
      "several parallel questions, observations, or angles in one turn, " +
      "break it into one self-contained question per direction and dispatch " +
      "all of them in the SAME step — tool calls within one step run " +
      "concurrently, so every direction gets full-depth thinking in " +
      "parallel, then you synthesize. Also reach for it when a single " +
      "question deserves sustained reasoning your live context would water " +
      "down: a trade-off or risk assessment, an unbiased second pass over a " +
      "conclusion you lean towards, or context too polluted to think " +
      "straight. Simple turns you simply answer — but do not skimp on " +
      "questions worth thinking about. Returns the conclusion plus its " +
      "thinking trail; a pod may come back partial (`status: timeout`) — " +
      "its `answer` and `reasoning` hold what it already produced; work " +
      "with them, or gather the missing facts yourself and dispatch a finer " +
      "question. Tag each question with the right effort: low for simple " +
      "logical verification, medium for a comparison, high for deep " +
      "structural analysis. Synthesize what comes back into your answer in " +
      "your own voice.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("Self-contained question for the thinking pod. Include all necessary context and facts — it has no tools and cannot look anything up."),
      effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Reasoning intensity: 'low' for simple logical verification (fast), 'medium' for a comparison, 'high' for deep analysis. Defaults to 'low'."),
    }),
    contextSchema: toolContextSchema,
    execute: thinkDeepExecute,
  }),
};

// ─── Client-mode-only tools (subscription bridge) ────────────────────────
//
// Registered ONLY in client mode (PREVIOUSLY_MODE=client): the bridge command
// is a local operator-controlled executable and cloud deployments must never
// expose it (doc/design/v0.9-client.md §2 — mode changes "who do I talk to",
// never identity). Chat-only, like recall/webSearch.
const delegateTaskTool = tool({
  description:
    "Delegate a self-contained task to the local subscription bridge — an " +
    "operator-installed adapter process that executes the task with the " +
    "user's own local tools/subscriptions and returns its stdout as the " +
    "result. Use it for work that needs something local rather than doing it " +
    "yourself. Embed everything the task needs in `task` and `context` — the " +
    "bridge has no access to your memory. On failure you get a structured " +
    "error with a reason (bridge-not-found / spawn-failed / timeout / " +
    "exit-code / empty-output) — report it honestly, then decide whether to " +
    "retry, rephrase, or do the work yourself.",
  inputSchema: z.object({
    task: z
      .string()
      .describe("Self-contained task instruction for the bridge to execute."),
    context: z
      .string()
      .optional()
      .describe("Supporting context the bridge needs (facts, constraints, inputs)."),
  }),
  contextSchema: toolContextSchema,
  execute: delegateTaskExecute,
});

/**
 * The chat tool set for this process: `chatTools`, plus the bridge dispatch
 * tool when running in client mode. Called at agent construction, inside the
 * workflow body — process.env is a frozen per-run snapshot there, so the mode
 * read is deterministic. The union return type (not an optional key) keeps
 * tool-call inference free of `undefined` for consumers like turn-workflow.
 */
export function getChatTools():
  | typeof chatTools
  | (typeof chatTools & { delegateTask: typeof delegateTaskTool }) {
  return isClientMode() ? { ...chatTools, delegateTask: delegateTaskTool } : chatTools;
}

// ─── toolsContext builders ───────────────────────────────────────────────

/** Same serializable chat context, fanned out to every chat tool by name. */
export function buildChatToolsContext(
  ctx: ToolContext,
): Record<keyof typeof chatTools, ToolContext> & { delegateTask?: ToolContext } {
  const contexts: Record<keyof typeof chatTools, ToolContext> = {
    readSlice: ctx,
    readPreviously: ctx,
    currentTime: ctx,
    recall: ctx,
    webSearch: ctx,
    thinkDeep: ctx,
  };
  // Keep the context map in lockstep with getChatTools(): a registered tool
  // must never lack its context entry.
  return isClientMode() ? { ...contexts, delegateTask: ctx } : contexts;
}

