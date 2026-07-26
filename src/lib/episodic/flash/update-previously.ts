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
"previously.md" that the agent reads before every turn.
It has three sections:

  1. User identity  — who the user is (name, role, background)
  2. User patterns  — how the user works (preferences, habits, dislikes)
  3. Agent strategies — how to work with this user effectively

Your job: thoroughly review ALL available context — the conversation AND the
agent's cognition log — then produce mutations where you have evidence.

For User identity / User patterns: be conservative — only report with clear evidence.
For Agent strategies: analyze the full cognition log. Thinking text is helpful but
NOT required — tool calls alone carry strategy signal. Consider:
  - What did the agent choose to do? Why might it have chosen that?
  - What tools did it use, in what order, with what queries/parameters?
  - Did it search before responding? In multiple languages? Beyond the literal question?
  - Did it read memory? Write to memory? Did anything fail?

Not every turn needs an update — but every turn deserves thorough analysis.
When the cognition log is empty (first turn), it's OK to return nothing.

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

The cognition log has two parts:
  - ### Thinking — agent's internal reasoning (may be empty)
  - ### Tools — tools the agent called and their outcomes

${cognitionPreview}

TOOL CALLS → STRATEGIES: Tool choices reveal how the agent works. When you see
patterns in the cognition log, consider whether they suggest a strategy worth
recording. Examples of what to look for:

  Agent searched in multiple languages for the same topic
  → Strategy: "Uses bilingual search for broader coverage"
  → evidence: specific tool calls that show the pattern

  Agent searched before responding (not after)
  → Strategy: "Researches before answering rather than responding from memory"

  Agent searched beyond the literal question
  → Strategy: "Proactively broadens search to adjacent topics"

  Agent read files or past memory
  → Strategy: "Checks existing context before taking action"

  Agent wrote to memory unprompted
  → Strategy: "Persists important findings for future turns"

  Tool returned error or empty results
  → Strategy: "Recognizes when an approach is unavailable and adapts"

Describe HOW the agent works, not WHAT it found. Use exact tool names and
query topics from the cognition log as evidence.

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
  - Identity: "<statement>\n(slice: ${sliceId}-${lastTurnId}, from user)"
  - Pattern: "<statement>\n(confidence: medium | first: ${sliceId}-${lastTurnId} | last: ${sliceId}-${lastTurnId} | obs: 1)"
  - Strategy: "<statement — include specific evidence in the text>\n(source: ${sliceId}-${lastTurnId})"
    The system adds the source annotation; you only write the belief statement.
    Embed evidence in the statement body, e.g.:
    "Uses bilingual search (CN+EN), e.g. webSearch('topic CN') + webSearch('topic EN')"

**reinforce** — existing belief is confirmed by new evidence
  - Match by belief_key (a phrase in the existing bullet)

**contradict** — evidence undermines an existing belief
  - note: explain the tension

**discard** — belief is stale, wrong, or a placeholder

### Document maintenance:

"_No beliefs yet._" placeholders are handled by the system — do NOT
emit discard actions for them. If an annotation is malformed, fix it
via reinforce with the corrected text.

---

IMPORTANT:
- Analyze ALL available context — conversation + cognition. Don't skip just
  because one source is thin. Tool calls without thinking still carry signal.
- Return [] when there is genuinely nothing to report — that's valid.
- For evidence_slice, use "${sliceId}"
- For evidence_turn, use "${lastTurnId}"
- ${isDeep ? "Deep mode: full session review. Scan ALL cognition entries for patterns across the entire session." : "Normal mode: review the latest turn. Focus on what changed or what new patterns emerged."}
- Both modes have equal authority over ALL three sections
- Call the flashOutput tool with your analysis.`;

  return prompt;
}

// ─── Pro call (formerly Flash) ──────────────────────────────────────────

const PRO_RETRY_DELAY_MS = 300;

async function attemptUpdate(
  prompt: string,
): Promise<{ belief_updates: BeliefUpdate[]; reasoning: string }> {
  const result = await generateText({
    model: deepseek("deepseek-v4-pro"),
    prompt,
    temperature: 0.1,
    tools: { flashOutput: outputSchema },
    toolChoice: "auto",
    // No thinking — this is a structured extraction task, not a reasoning task.
    // Thinking tokens add latency with negligible benefit for fact extraction.
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

  // Pro returned text without calling the tool — use the text as reasoning
  // but produce no belief updates.
  if (result.text?.trim()) {
    console.warn(
      "[Previously] Pro returned text instead of tool call:",
      result.text.slice(0, 200),
    );
    return { belief_updates: [], reasoning: result.text.slice(0, 200) };
  }

  throw new Error("Pro did not call the expected tool");
}

/**
 * Run the merged previously update Pro call.
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
    await new Promise((resolve) => setTimeout(resolve, PRO_RETRY_DELAY_MS));
    try {
      const result = await attemptUpdate(prompt);
      return { ...result, isDeep: input.isDeep };
    } catch {
      return {
        belief_updates: [],
        reasoning: "Previously update Pro unavailable",
        isDeep: input.isDeep,
      };
    }
  }
}
