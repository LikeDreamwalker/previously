/**
 * Flash Belief Update — focused Flash call for previously.md observation.
 *
 * A single DeepSeek Flash call that examines the current conversation against
 * the existing belief system (previously.md) and produces belief mutations
 * (observe/reinforce/contradict/discard). Runs as a pre-turn step.
 */

import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type { BeliefUpdate } from "@/lib/episodic/maintenance";

// ─── Types ──────────────────────────────────────────────────────────────

export interface BeliefUpdateInput {
  recentTurns: Array<{ role: string; content: string }>;
  newMessage: string;
  previouslyContent: string;
  sliceId: string;
  /** Recent agent cognition (thinking traces + tool calls) as additional evidence. */
  agentCognition?: string;
}

export interface BeliefUpdateOutput {
  belief_updates: BeliefUpdate[];
  reasoning: string;
}

// ─── Structured output schema ──────────────────────────────────────────

const beliefSchema = tool({
  description: "Report belief mutations observed this turn.",
  inputSchema: z.object({
    belief_updates: z
      .array(
        z.object({
          action: z
            .enum(["observe", "reinforce", "contradict", "discard"])
            .describe("What to do with this belief"),
          section: z
            .enum(["User identity", "User patterns", "Agent strategies"])
            .describe("Which section the belief belongs to"),
          belief: z
            .string()
            .optional()
            .describe("Full belief text. Required for 'observe'."),
          belief_key: z
            .string()
            .optional()
            .describe(
              "Unique substring to match an existing belief. Required for " +
              "'reinforce' / 'contradict' / 'discard'. Must appear in the " +
              "belief bullet line, not the annotation.",
            ),
          evidence_slice: z
            .string()
            .describe("Slice path in YYYY/MM/DD/HHMM format for the citing evidence"),
          evidence_turn: z
            .string()
            .describe("Turn ID within the evidence slice"),
          note: z
            .string()
            .optional()
            .describe("Explanation of the tension (for 'contradict')"),
          reason: z
            .string()
            .optional()
            .describe("Why removing (for 'discard')"),
        }),
      )
      .describe(
        "Belief mutations observed this turn. Empty array if no clear evidence.",
      ),

    reasoning: z
      .string()
      .describe("Brief reasoning about what you observed (1-2 sentences)"),
  }),
});

// ─── Prompt builder ────────────────────────────────────────────────────

function buildBeliefPrompt(input: BeliefUpdateInput): string {
  const { recentTurns, newMessage, previouslyContent, sliceId } = input;

  let prompt = `You are the belief observation layer for a personal AI platform.
Your job: watch the conversation for new information about the user and produce
belief mutations.

## Current Time Slice
- ID: ${sliceId}

## Recent Conversation (last ${recentTurns.length} turns)
`;

  for (const t of recentTurns.slice(-8)) {
    prompt += `${t.role}: ${t.content.slice(0, 500)}\n\n`;
  }

  prompt += `## New User Message
"${newMessage}"

`;

  // Include recent agent cognition as an additional observation lens.
  // The agent's thinking traces often contain implicit observations about
  // the user (preferences, patterns, testing behavior) that the raw
  // conversation text alone doesn't capture.
  if (input.agentCognition?.trim()) {
    const cognition = input.agentCognition.length > 1200
      ? input.agentCognition.slice(-1200)
      : input.agentCognition;
    prompt += `## Recent Agent Cognition (what the agent was thinking during previous turns)

${cognition}

The agent's internal reasoning may reveal implicit patterns about the user.
Use this as supplementary evidence — the user's actual words take priority.
`;
  }

  if (previouslyContent.trim()) {
    prompt += `## Current Beliefs (previously.md — the agent's understanding of the user)

${previouslyContent.slice(0, 3000)}

`;
  } else {
    prompt += `## Current Beliefs (previously.md)
No beliefs established yet.

`;
  }

  prompt += `## Your Task

Examine the user's latest message and the conversation. Produce belief_updates.

Evidence quality rules:
- User explicitly states a fact about themselves → "observe" in "User identity"
- User behavior confirms an existing pattern belief → "reinforce" (bump count)
- User behavior contradicts an existing belief → "contradict" with a note
- Stale belief not reinforced in many turns + confidence already 低 → "discard"

For "observe":
- User identity: use 来源 format (factual, user-stated)
- User patterns: use 置信度 format, start at 中 confidence, 观察: 1
- Agent strategies: use 来源 format, cite the motivating User pattern

For "reinforce": bump 观察 count. If ≥5 observations and confidence is 中, promote to 高.
For "contradict": drop confidence one level, explain the tension in note.
For "discard": only when confidence is 低 and no recent reinforcement.

Return belief_updates as an array. Return [] if no clear evidence this turn.
Do NOT fabricate observations just to fill the output.

Call the flashOutput tool with your analysis.`;

  return prompt;
}

// ─── Flash call ────────────────────────────────────────────────────────

const FLASH_RETRY_DELAY_MS = 300;

async function attemptBeliefUpdate(
  prompt: string,
): Promise<BeliefUpdateOutput> {
  const result = await generateText({
    model: deepseek("deepseek-v4-flash"),
    prompt,
    temperature: 0.1,
    tools: { flashOutput: beliefSchema },
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
 * Run the belief update Flash call.
 * Never throws — falls back to empty updates on failure.
 */
export async function runBeliefUpdate(
  input: BeliefUpdateInput,
): Promise<BeliefUpdateOutput> {
  const prompt = buildBeliefPrompt(input);

  try {
    return await attemptBeliefUpdate(prompt);
  } catch (firstError) {
    console.warn(
      "[Belief] First attempt failed, retrying:",
      firstError instanceof Error ? firstError.message : firstError,
    );
    await new Promise((resolve) => setTimeout(resolve, FLASH_RETRY_DELAY_MS));
    try {
      return await attemptBeliefUpdate(prompt);
    } catch {
      return {
        belief_updates: [],
        reasoning: "Belief Flash unavailable, no updates applied",
      };
    }
  }
}
