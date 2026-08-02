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

export interface RecallSearchOutput {
  hits: RecallHit[];
  confidence: number;
  reasoning: string;
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

// ─── Sub-agent tool: readSlice ────────────────────────────────────────

function sliceIdToCorePath(sliceId: string): string {
  const parts = sliceId.split("-");
  if (parts.length >= 4) {
    const [y, m, d, hm] = parts;
    return `memory/episodic/slices/${y}/${m}/${d}/${hm}/timeline/core.md`;
  }
  // Legacy format: YYYY-MM-DD
  const [y, m, d] = parts;
  return `memory/episodic/slices/${y}/${m}/${d}/core.md`;
}

async function readSliceImpl(sliceId: string): Promise<string> {
  try {
    const path = sliceIdToCorePath(sliceId);
    const content = await fsReadFile(path);
    // Return last ~2000 chars for context — enough to see recent turns
    if (content.length > 2500) {
      return (
        "(Last ~2500 chars of slice)\n" +
        content.slice(-2500)
      );
    }
    return content;
  } catch {
    return `Slice "${sliceId}" not found or could not be read.`;
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
  }),
});

// ─── Agent setup ──────────────────────────────────────────────────────

const RECALL_SYSTEM_PROMPT = `You are the recall search engine for a personal AI platform.
Your job: find past conversations relevant to a search query.

Process:
1. Read the global timeline index to see all available past conversations with their summaries.
2. If a topic seems relevant, you can use readStrand to trace it across slices, or readSlice to inspect specific slices for more detail.
3. When you have enough information, call recallReport with your findings.

Guidelines:
- Be thorough but efficient — aim for 2-4 steps.
- Only report slices with a clear connection to the query.
- If nothing is relevant, return an empty hits array. That's fine.
- Focus on RECALLING context, not answering the question.
- key_turns should identify specific turns within a slice that are relevant (if you read the slice).

The current session is NOT in the timeline — it only contains closed past slices.`;

// ─── Public API ────────────────────────────────────────────────────────

const MAX_STEPS = 20;

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
  const { query, currentSliceId, strandsContext } = input;

  const strandsHint = strandsContext && Object.keys(strandsContext).length > 0
    ? `
Available strands (keyword tags threaded across slices): ${Object.keys(strandsContext).join(", ")}
IMPORTANT: After reading the global timeline, check which strands match your query. Use readStrand to trace matching strands — they give you a direct path to relevant slices.`
    : "";

  const userPrompt = `Search query: "${query}"

Current slice: ${currentSliceId}${strandsHint}

Follow this process:
1. START — call readGlobalTimeline to see all available past conversations.
2. EXPLORE — trace any matching strands with readStrand, then deep-read promising slices with readSlice.
3. REPORT — call recallReport with your findings.

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
        readSlice: tool({
          description:
            "Read the full content of a specific time slice. Use this to inspect " +
            "promising slices identified from the timeline or strand search.",
          inputSchema: z.object({
            sliceId: z
              .string()
              .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
          }),
          execute: async ({ sliceId }: { sliceId: string }) => {
            const content = await readSliceImpl(sliceId);
            return content;
          },
        }),
        recallReport: recallReportSchema,
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
        };
        console.log(
          `[Recall] Found ${report.hits?.length ?? 0} hits, confidence=${(report.confidence ?? 0).toFixed(2)}`,
        );
        return {
          hits: report.hits ?? [],
          confidence: report.confidence ?? 0.5,
          reasoning: report.reasoning ?? "",
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
    };
  }
}
