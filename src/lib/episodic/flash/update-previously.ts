/**
 * Update Previously — single Flash call that reviews BOTH the user conversation
 * AND the agent's own cognition, producing mutations for all three sections of
 * previously.md in one pass.
 *
 * Sections:
 *   1. User identity   — facts about who the user is (from conversation)
 *   2. User patterns   — how the user works (from conversation)
 *   3. Agent strategies — how to work with this user (from agent cognition)
 *
 * Modes:
 *   normal — every turn, reviews last turn's cognition only
 *   deep   — on slice close, reviews full closed slice's agent.md
 */

import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type { BeliefUpdate } from "@/lib/episodic/maintenance";

// ─── Types ──────────────────────────────────────────────────────────────

export interface UpdatePreviouslyInput {
  recentTurns: Array<{ role: string; content: string }>;
  newMessage: string;
  previouslyContent: string;
  sliceId: string;
  lastTurnId: string;
  /** Agent cognition (thinking traces + tool calls) for strategy review. */
  agentCognition: string;
  /** Whether this is a deep review (slice close). */
  isDeep: boolean;
  /** Closed slice ID for deep mode context. */
  closedSliceId?: string;
}

export interface UpdatePreviouslyOutput {
  belief_updates: BeliefUpdate[];
  reasoning: string;
  isDeep: boolean;
}

// ─── Structured output schema ──────────────────────────────────────────

const outputSchema = tool({
  description: "Report belief and strategy mutations observed this turn.",
  inputSchema: z.object({
    belief_updates: z
      .array(
        z.object({
          action: z
            .enum(["observe", "reinforce", "contradict", "discard"])
            .describe("What to do with this belief/strategy"),
          section: z
            .enum(["User identity", "User patterns", "Agent strategies"])
            .describe("Which section the mutation belongs to"),
          belief: z
            .string()
            .optional()
            .describe("Full text. Required for 'observe'."),
          belief_key: z
            .string()
            .optional()
            .describe(
              "Key phrase to match an existing item. Required for " +
              "'reinforce' / 'contradict' / 'discard'.",
            ),
          evidence_slice: z
            .string()
            .describe(
              "Slice path in YYYY/MM/DD/HHMM format for the citing evidence. " +
              "Use the slice ID provided in the context.",
            ),
          evidence_turn: z
            .string()
            .describe("Turn ID within the evidence slice"),
          note: z
            .string()
            .optional()
            .describe("What changed (for 'contradict')"),
          reason: z
            .string()
            .optional()
            .describe("Why removing (for 'discard')"),
        }),
      )
      .describe(
        "Mutations across all three sections. Empty if no clear evidence.",
      ),

    reasoning: z
      .string()
      .describe("1-2 sentences summarizing what you observed this turn"),
  }),
});

// ─── Prompt builder ────────────────────────────────────────────────────

function buildPrompt(input: UpdatePreviouslyInput): string {
  const {
    recentTurns,
    newMessage,
    previouslyContent,
    sliceId,
    lastTurnId,
    agentCognition,
    isDeep,
  } = input;

  let prompt = `You maintain the agent's knowledge base — a document called
"前情提要" (previously.md) that the agent reads before every turn.
It has three sections:

  1. User identity  — who the user is (name, role, background)
  2. User patterns  — how the user works (preferences, habits, dislikes)
  3. Agent strategies — how to work with this user effectively

Your job: review the latest conversation AND the agent's own thinking
traces, then produce mutations for any section where you have clear evidence.

You are CONSERVATIVE. Most turns produce 0-1 mutations. Do not fabricate.

---

## Current Slice
${sliceId} / Last turn: ${lastTurnId}

`;

  // ── Source A: Conversation (for User sections) ─────────────────────

  prompt += `## Source A — Conversation (User identity & patterns)

Recent turns:
`;
  for (const t of recentTurns.slice(-8)) {
    prompt += `${t.role}: ${t.content.slice(0, 500)}\n\n`;
  }

  prompt += `New user message:
"${newMessage}"

`;

  // ── Source B: Agent cognition (for Agent strategies) ───────────────

  const cognitionPreview = agentCognition.trim()
    ? agentCognition.slice(isDeep ? -8000 : -3000)
    : "(No cognition yet — first turn)";

  prompt += `## Source B — Agent Cognition${isDeep ? " (DEEP — full session)" : " (last turn)"}

${cognitionPreview}

`;

  // ── Current beliefs ────────────────────────────────────────────────

  if (previouslyContent.trim()) {
    prompt += `## Current previously.md

${previouslyContent.slice(0, 4000)}

`;
  }

  // ── Task ────────────────────────────────────────────────────────────

  prompt += `## Your Task

You maintain ALL three sections of previously.md. Use the conversation
(Source A) primarily for User identity/patterns and the cognition
(Source B) primarily for Agent strategies, but either source can inform
any section — a user pattern might suggest a strategy, and a cognition
trace might reveal a user preference.

### For any section:

**observe** — new belief with concrete evidence
  - Identity: "<statement>\n(来源: <user quote> — ${sliceId}-${lastTurnId})"
  - Pattern: "<statement>\n(置信度: 中 | 首次: ${sliceId}-${lastTurnId} | 最近: ${sliceId}-${lastTurnId} | 观察: 1)"
  - Strategy: "<statement>\n(来源: <cognition excerpt> — ${sliceId}-${lastTurnId})"

**reinforce** — existing belief is confirmed by new evidence
  - Match by belief_key (a phrase in the existing bullet)

**contradict** — evidence undermines an existing belief
  - note: explain the tension

**discard** — belief is stale, wrong, or a placeholder

### Document maintenance:

If you see "_No beliefs yet._" in a section that has beliefs listed
below it, discard that placeholder. If an annotation is malformed, fix
it via reinforce with the corrected text.

---

IMPORTANT:
- Return [] if no clear evidence — that's normal
- For evidence_slice, use "${sliceId}"
- For evidence_turn, use "${lastTurnId}"
- ${isDeep ? "Deep mode: full session review. Up to 3 mutations OK." : "Normal mode: last turn only. 0-1 mutations typical."}
- Both modes have equal authority over ALL three sections
- Call the flashOutput tool with your analysis.`;

  return prompt;
}

// ─── Flash call ────────────────────────────────────────────────────────

const FLASH_RETRY_DELAY_MS = 300;

async function attemptUpdate(
  prompt: string,
): Promise<{ belief_updates: BeliefUpdate[]; reasoning: string }> {
  const result = await generateText({
    model: deepseek("deepseek-v4-flash"),
    prompt,
    temperature: 0.1,
    tools: { flashOutput: outputSchema },
    toolChoice: "required",
    providerOptions: {
      deepseek: { thinking: { type: "disabled" as const } },
    },
  });

  const toolCall = result.toolCalls?.[0];
  if (
    toolCall?.toolName === "flashOutput" &&
    (toolCall as Record<string, unknown>).input
  ) {
    const input = (toolCall as Record<string, unknown>).input as {
      belief_updates: BeliefUpdate[];
      reasoning: string;
    };
    return {
      belief_updates: input.belief_updates ?? [],
      reasoning: input.reasoning ?? "",
    };
  }

  throw new Error("Flash did not call the expected tool");
}

/**
 * Run the merged previously update Flash call.
 * Never throws — falls back to empty updates on failure.
 */
export async function runUpdatePreviously(
  input: UpdatePreviouslyInput,
): Promise<UpdatePreviouslyOutput> {
  const prompt = buildPrompt(input);

  try {
    const result = await attemptUpdate(prompt);
    return { ...result, isDeep: input.isDeep };
  } catch (firstError) {
    console.warn(
      "[Previously] First attempt failed, retrying:",
      firstError instanceof Error ? firstError.message : firstError,
    );
    await new Promise((resolve) => setTimeout(resolve, FLASH_RETRY_DELAY_MS));
    try {
      const result = await attemptUpdate(prompt);
      return { ...result, isDeep: input.isDeep };
    } catch {
      return {
        belief_updates: [],
        reasoning: "Previously update Flash unavailable",
        isDeep: input.isDeep,
      };
    }
  }
}
