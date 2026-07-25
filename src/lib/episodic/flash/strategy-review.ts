/**
 * Strategy Review — Flash reviews the agent's own cognition (thinking traces +
 * tool calls) and proposes mutations to the "Agent strategies" section of
 * previously.md. This is the agent's self-evolution loop.
 *
 * Two modes:
 *   normal — every turn, reviews the last turn's cognition only (~2s)
 *   deep   — on slice close, reviews the full closed slice's agent.md (~5s)
 *
 * Deep mode is triggered when `closedSliceId` is provided — the closed slice's
 * complete agent timeline is read and reviewed. Normal mode only reads the
 * current slice's agent.md (which contains just the last written cognition).
 */

import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type { BeliefUpdate } from "@/lib/episodic/maintenance";

// ─── Types ──────────────────────────────────────────────────────────────

export interface StrategyReviewInput {
  /** The agent's cognition text (thinking traces + tool calls). */
  agentCognition: string;
  /** The current previously.md content (baseline strategies). */
  currentStrategies: string;
  /** The active slice ID (for evidence citation). */
  sliceId: string;
  /** The turn ID of the last agent turn (for evidence citation). */
  lastTurnId: string;
  /** The user's message from the last turn (context for what the agent was responding to). */
  lastUserMessage: string;
  /** The closed slice's ID when in deep mode. */
  closedSliceId?: string;
}

export interface StrategyReviewOutput {
  belief_updates: BeliefUpdate[];
  reasoning: string;
  /** Whether this was a deep review. */
  isDeep: boolean;
}

// ─── Structured output schema ──────────────────────────────────────────

const strategySchema = tool({
  description: "Report strategy mutations based on the agent's own work.",
  inputSchema: z.object({
    belief_updates: z
      .array(
        z.object({
          action: z
            .enum(["observe", "reinforce", "contradict", "discard"])
            .describe("What to do with this strategy"),
          section: z
            .literal("Agent strategies")
            .describe("Must be 'Agent strategies' for strategy review"),
          belief: z
            .string()
            .optional()
            .describe(
              "The strategy belief text. Required for 'observe'. " +
              "Format: the strategy statement, then on a new line " +
              "`(来源: {concrete cognition excerpt} — {slice-turn})`.",
            ),
          belief_key: z
            .string()
            .optional()
            .describe(
              "Key phrase to match an existing strategy. Required for " +
              "'reinforce' / 'contradict' / 'discard'.",
            ),
          evidence_turn: z
            .string()
            .describe("Turn ID for citation"),
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
        "Strategy mutations. Empty array if no clear evidence this turn.",
      ),

    reasoning: z
      .string()
      .describe("1-2 sentences about what you observed in the agent's work"),
  }),
});

// ─── Prompt builder ────────────────────────────────────────────────────

function buildStrategyPrompt(
  input: StrategyReviewInput,
  isDeep: boolean,
): string {
  const { agentCognition, currentStrategies, sliceId, lastTurnId, lastUserMessage } = input;

  const strategiesSection = currentStrategies.trim()
    ? extractStrategiesSection(currentStrategies)
    : "No strategies established yet.";

  let prompt = `You are the strategy auditor for a personal AI agent. Your job:
review the agent's own work and suggest improvements to its operating
strategies stored in the "Agent strategies" section of the agent's
knowledge base.

You are CONSERVATIVE. Only suggest a change when you have clear, concrete
evidence from the agent's thinking traces or tool calls. Most turns will
produce no mutations — that is normal and expected.

## Current Context
- Slice: ${sliceId}
- Last turn: ${lastTurnId}
- User was asking about: "${lastUserMessage.slice(0, 300)}"
`;

  if (isDeep) {
    prompt += `\n## Mode: DEEP REVIEW
This slice just closed. You are reviewing the complete cognition history
of the ENTIRE session. Look for patterns across multiple turns — strategies
that emerged, evolved, or should be reconsidered.

`;
  } else {
    prompt += `\n## Mode: NORMAL REVIEW
Review only the last turn's cognition below. Check if it confirms or
contradicts any existing strategy, or reveals a new one.

`;
  }

  prompt += `## Agent Cognition (${isDeep ? "full session" : "last turn"})

${agentCognition.slice(isDeep ? -8000 : -3000)}

`;

  prompt += `## Current Strategies (Agent strategies section)

${strategiesSection}

`;

  prompt += `## Your Task

1. Read the agent's cognition carefully.
2. Compare against current strategies.
3. Output mutations ONLY when you have concrete evidence.

### When to act

**observe** — a new effective pattern appears:
- A tool call sequence worked well (e.g. "recall → readSlice was efficient")
- A reasoning approach led to a good outcome
- Format: "<strategy statement>\n(来源: <excerpt from cognition> — ${sliceId}-${lastTurnId})"

**reinforce** — the last turn confirms an existing strategy:
- The agent followed a strategy and it worked
- Match by belief_key (a key phrase in the strategy bullet)

**contradict** — the last turn shows a strategy is wrong or outdated:
- The agent followed a strategy and it failed
- The agent found a better approach

**discard** — a strategy is clearly stale:
- Multiple recent turns show it's no longer applicable

### Evidence rules
- MUST cite a specific thinking passage or tool call
- Never fabricate — "seems reasonable" is NOT evidence
- For normal mode: 0-1 mutations is typical
- For deep mode: 0-3 mutations is typical

Call the flashOutput tool with your analysis.`;

  return prompt;
}

/**
 * Extract just the Agent strategies section from previously.md.
 * Falls back to the full content if no section header is found.
 */
function extractStrategiesSection(content: string): string {
  const match = content.match(/### Agent strategies\n([\s\S]*?)(?=\n### |\n_Active|\n$)/);
  return match ? match[1].trim() : content.slice(0, 2000);
}

// ─── Flash call ────────────────────────────────────────────────────────

const FLASH_RETRY_DELAY_MS = 300;

async function attemptStrategyReview(
  prompt: string,
): Promise<StrategyReviewOutput> {
  const result = await generateText({
    model: deepseek("deepseek-v4-flash"),
    prompt,
    temperature: 0.1,
    tools: { flashOutput: strategySchema },
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
      isDeep: false,
    };
  }

  throw new Error("Flash did not call the expected tool");
}

/**
 * Run the strategy review Flash call.
 * Never throws — falls back to empty updates on failure.
 */
export async function runStrategyReview(
  input: StrategyReviewInput,
): Promise<StrategyReviewOutput> {
  const isDeep = input.closedSliceId !== undefined;
  const prompt = buildStrategyPrompt(input, isDeep);

  try {
    const result = await attemptStrategyReview(prompt);
    return { ...result, isDeep };
  } catch (firstError) {
    console.warn(
      "[Strategy] First attempt failed, retrying:",
      firstError instanceof Error ? firstError.message : firstError,
    );
    await new Promise((resolve) => setTimeout(resolve, FLASH_RETRY_DELAY_MS));
    try {
      const result = await attemptStrategyReview(prompt);
      return { ...result, isDeep };
    } catch {
      return {
        belief_updates: [],
        reasoning: "Strategy review Flash unavailable",
        isDeep,
      };
    }
  }
}
