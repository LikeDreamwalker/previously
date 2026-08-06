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
import { fsReadFile } from "../io-helpers";
import { readStrands } from "@/lib/episodic/manager";
import { generateGlobalTimeline } from "@/lib/episodic/flash/global-timeline";
import { createModel } from "@/lib/models/provider";
import { workerProviderOptions } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";

// ─── Types ──────────────────────────────────────────────────────────────

export interface RecallHit {
  slice_id: string;
  relevance: number;
  reason: string;
  key_turns: number[];
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

export interface RecallSearchOutput {
  hits: RecallHit[];
  confidence: number;
  reasoning: string;
  /** Slices worth opening with readSlice — the recall agent's advisory output. */
  recommendedReads: RecommendedRead[];
}

export interface RecallSearchInput {
  query: string;
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

async function readGlobalTimelineImpl(): Promise<string> {
  try {
    const content = await fsReadFile(GLOBAL_TIMELINE_PATH);
    if (content.trim()) {
      // Defense in depth: check if the timeline is stale.
      // Even though the lifecycle should keep it fresh, a stale timeline
      // is worse than a slow regeneration — the recall agent would return
      // 0 hits if it can't see recent slices.
      const match = content.match(/_Generated: ([^\n]+)_/);
      if (match) {
        const genTime = new Date(match[1]).getTime();
        const ageMs = Date.now() - genTime;
        if (ageMs > STALE_THRESHOLD_MS) {
          console.log(
            `[Recall] Global timeline stale (${Math.round(ageMs / 3_600_000)}h old), regenerating...`,
          );
          return await generateGlobalTimeline();
        }
      }
      return content;
    }
    // File exists but is empty — regenerate
    return await generateGlobalTimeline();
  } catch {
    // File doesn't exist yet — generate it from monthly indices
    try {
      return await generateGlobalTimeline();
    } catch (genErr) {
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
          relevance: z
            .number()
            .min(0)
            .max(1)
            .describe("How relevant this slice is to the query, 0-1"),
          reason: z
            .string()
            .describe("One-line explanation of why this slice is relevant"),
          key_turns: z
            .array(z.number())
            .describe(
              "Turn numbers within the slice that are most relevant. Empty array if you didn't deep-read the slice.",
            ),
        }),
      )
      .describe("Relevant slices found. Empty if nothing matches."),

    confidence: z
      .number()
      .min(0)
      .max(1)
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

You work from SUMMARIES ONLY — the global timeline holds one summary per closed slice. You NEVER read slice content (no readSlice tool). Your value is fast, accurate navigation over the memory index.

Process:
1. Read the global timeline index to see all available past conversations with their summaries.
2. If a topic seems relevant, use readStrand to trace it across slices — the strand maps a keyword to its slice paths.
3. When you have enough information, call recallReport with:
   - hits: slices with a clear connection to the query (with a one-line reason).
   - recommended_reads: slices the main agent should consider opening with readSlice — the slices whose summaries suggest the deepest or most direct relevance. The main agent decides whether to read them; you only advise.

Guidelines:
- Be thorough but efficient — aim for 2-4 steps.
- Base relevance and priority on summary quality, strand overlap, and tag relevance — not on content you never read.
- Do NOT invent key_turns: without reading a slice you cannot know which turns matter, so leave key_turns empty.
- If nothing is relevant, return an empty hits array. That's fine.
- Focus on RECALLING context, not answering the question.

The current session is NOT in the timeline — it only contains closed past slices.`;

// ─── Public API ────────────────────────────────────────────────────────

const MAX_STEPS = 5;

/**
 * Run the recall search mini-agent using AI SDK v7 native multi-step.
 *
 * `stopWhen: isStepCount(5)` tells generateText to loop: after each tool
 * call, feed the result back to the model and continue, up to 5 turns.
 * This gives Flash time to explore (timeline → strands → deep-read) and
 * then call recallReport.
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

Current slice: ${currentSliceId}${strandsHint}

Follow this process:
1. START — call readGlobalTimeline to see all available past conversations and their summaries.
2. EXPLORE — trace any matching strands with readStrand to find which slices carry the topic.
3. REPORT — call recallReport with your findings, including recommended_reads advising the main agent which slices are worth opening.

IMPORTANT: You MUST end by calling recallReport. Even if nothing matches, call it with an empty hits array.`;

  try {
    const result = await generateText({
      model: createModel(input.model),
      system: RECALL_SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0.1,
      tools: {
        readGlobalTimeline: tool({
          description:
            "Read the global timeline index — contains summaries of all past " +
            "conversation slices. Always start here to see what's available.",
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
        console.log(
          `[Recall] Found ${report.hits?.length ?? 0} hits, ${report.recommended_reads?.length ?? 0} recommended reads, confidence=${(report.confidence ?? 0).toFixed(2)}`,
        );
        return {
          hits: report.hits ?? [],
          confidence: report.confidence ?? 0.5,
          reasoning: report.reasoning ?? "",
          recommendedReads: normalizeRecommendedReads(report.recommended_reads),
        };
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
