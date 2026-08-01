/**
 * Previously Agent — the "brain" that maintains previously.md.
 *
 * Gate model: the core agent signals "hey, something might need updating."
 * The Previously Agent gets pre-loaded context (enough for shallow edits), then
 * decides autonomously:
 *
 *   1. Nothing to do → report empty mutations
 *   2. Shallow edit → apply changes from pre-loaded data
 *   3. Deep exploration → call tools to read more slices / timelines,
 *      then produce mutations
 *
 * Uses the PRO model without thinking (structured review task, not creative).
 * Output is structured via the `previouslyOutput` tool call.
 */

import { generateText, tool, isStepCount } from "ai";
import { z } from "zod";
import { createModel } from "@/lib/models/provider";
import { workerProviderOptions } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";

// ─── Types ──────────────────────────────────────────────────────────────

export type PreviouslySignal =
  | "new_observation"
  | "user_correction"
  | "slice_closed"
  | "self_reflection";

export interface PreviouslyAgentInput {
  signal: PreviouslySignal;
  note: string;
  /** The worker model to run the belief review on (resolved from config). */
  model: ModelConfig;
  /** Slice the core agent is currently on. */
  currentSliceId: string;
  /** If a slice just closed, its id (triggers deeper exploration). */
  closedSliceId?: string;
  /** The document to mutate — pre-loaded by the executor. */
  previouslyContent: string;
  /** Current slice's agent.md — pre-loaded by the executor. */
  agentCognition: string;
  /** What triggered this update (last exchange + current user msg). */
  recentTurns: Array<{ role: string; content: string }>;
  /** Tags on the current slice — helps contextualize the conversation. */
  currentSliceTags?: string[];

  // ── Tool implementations (callbacks provided by the executor) ──────

  /** Read a slice's conversation (core.md) — optional range filter. */
  readSliceFn: (sliceId: string, range?: {
    type: "turns" | "last" | "date";
    indices?: number[];
    count?: number;
    after?: string;
  }) => Promise<string>;
  /** Read agent.md for any slice. */
  readAgentTimelineFn: (sliceId: string) => Promise<string>;
  /** Read previously.md for any slice (historical comparison). */
  readPreviouslyFn: (sliceId: string) => Promise<string>;
}

export interface PreviouslyMutation {
  action: "observe" | "reinforce" | "contradict" | "discard" | "expire" | "promote" | "demote";
  tier: "long" | "short";
  subsection: "identity" | "patterns" | "strategies" | "context";
  belief?: string;
  belief_key?: string;
  evidence_slice?: string;
  evidence_turn?: string;
  note?: string;
  new_confidence?: "high" | "medium" | "low";
}

export interface PreviouslyAgentOutput {
  mutations: PreviouslyMutation[];
  reasoning: string;
}

// ─── Structured output schema ──────────────────────────────────────────

const outputSchema = z.object({
  mutations: z
    .array(
      z.object({
        action: z
          .enum(["observe", "reinforce", "contradict", "discard", "expire", "promote", "demote"])
          .describe("What to do with this belief."),
        tier: z.enum(["long", "short"]).describe("long = long-term memory, short = short-term memory."),
        subsection: z
          .enum(["identity", "patterns", "strategies", "context"])
          .describe("Which subsection. For short-term, always 'context'."),
        belief: z.string().optional().describe(
          "Full belief text. Required for: observe, promote (short→long), demote (long→short).",
        ),
        belief_key: z.string().optional().describe(
          "Key phrase to match an existing belief. Required for: reinforce, contradict, discard, expire.",
        ),
        evidence_slice: z.string().optional().describe("Slice path YYYY/MM/DD/HHMM for evidence."),
        evidence_turn: z.string().optional().describe("Turn ID within the evidence slice."),
        note: z.string().optional().describe("Explanation for contradict, discard, or expire."),
        new_confidence: z.enum(["high", "medium", "low"]).optional().describe(
          "New confidence when promoting or demoting.",
        ),
      }),
    )
    .describe("Mutations to apply. Empty array [] = nothing to change."),
  reasoning: z.string().describe("1-3 sentences for the developer log. Not shown to the core agent."),
});

// ─── Prompt ────────────────────────────────────────────────────────────

function buildPrompt(input: PreviouslyAgentInput): string {
  const { signal, note, currentSliceId, closedSliceId, previouslyContent, agentCognition, recentTurns, currentSliceTags } = input;

  const signalLabels: Record<PreviouslySignal, string> = {
    new_observation: "new_observation — core agent noticed new information about the user",
    user_correction: "user_correction — user said something in previously.md is wrong",
    slice_closed: "slice_closed — a time slice just closed, good moment for deep review",
    self_reflection: "self_reflection — core agent thinks its strategy needs adjustment",
  };

  const deepNote = closedSliceId
    ? `\n**DEEP MODE**: slice \`${closedSliceId}\` just closed. Consider reading its conversation and agent.md for patterns worth promoting or demoting.`
    : "";

  const tagsNote = currentSliceTags && currentSliceTags.length > 0
    ? `\n**Current slice tags**: ${currentSliceTags.join(", ")}`
    : "";

  return `You are the Previously Agent — the "brain" that maintains the agent's self-model
(previously.md). You do NOT talk to users. You work autonomously.

## Signal

${signalLabels[signal]}
Note from core agent: "${note}"${tagsNote}
Current slice: \`${currentSliceId}\`${deepNote}

## Iron Rules (铁律 — must follow EXACTLY)

### Write rules
R1. Every belief must cite at least one evidence reference. No unsourced inference.
R2. Short-term beliefs MUST have an expiry (default: 7 days from now).
R3. New belief same as existing → reinforce, do NOT create duplicate.
R4. New belief is a subset of existing → merge, do NOT create duplicate.
R5. Identity (WHO the user IS) → long-term. State (WHAT they're DOING now) → short-term.

### Upgrade / downgrade rules
R6. Short-term item referenced in 3+ slices → promote to long-term.
R7. Long-term item with no new evidence in 2+ reviews → demote confidence (high→medium→low).
R8. Short-term item not mentioned in 2+ reviews → mark stale. 3rd review → discard.
R9. Short-term item past its expiry → expire (delete).

### Forgetting rules
R10. User correction → mark old belief superseded, create new one. Do NOT physically delete old.
R11. Two long-term beliefs contradict → keep the one with stronger evidence, supersede the weaker.
R12. Long-term belief with confidence:low AND obs:1 → demote to short-term (expires in 3 days).

### Quantity limits
R13. Max: identity ≤ 20, patterns ≤ 8, strategies ≤ 15, context ≤ 10.
     If over limit, sort by (confidence_score × recency), remove lowest.
     confidence_score: high=3, medium=2, low=1. recency = 1 / (days_since_updated + 1).

## Previously.md (current — the document you mutate)

${previouslyContent || "(empty template — this is a new slice. Feel free to start from scratch.)"}

## Agent Cognition (current slice)

${agentCognition || "(no cognition yet — this is the first turn in this slice)"}

## Recent Conversation

${recentTurns.length > 0
  ? recentTurns.map((t) => `**${t.role}**: ${t.content}`).join("\n\n")
  : "(No recent conversation provided.)"}

## Your Process

**FIRST — QUICK SCAN (do NOT call any tools yet):**

1. Scan the recent conversation. Is there any genuinely new information about the user?
2. Scan previously.md. Are there expired short-term items? Stale long-term beliefs?
3. Scan agent cognition. Any reasoning errors worth correcting?

**Decision point:**

- **Nothing to change** → call \`previouslyOutput({ mutations: [], reasoning: "..." })\` IMMEDIATELY.
  Do NOT call any tools. This is the most common and fastest path.
- **Shallow edit possible** → call \`previouslyOutput\` with your mutations from pre-loaded data.
- **Need more evidence** → use the tools below to read specific slices, then call \`previouslyOutput\`.

**Semantic merging:** When the same concept appears in different languages (e.g., "self-evolution" and "自我进化"), treat them as ONE belief — reinforce the existing one, do NOT create duplicates.

## Your Tools

| Tool | When to use |
|------|-------------|
| \`readSlice(sliceId, range?)\` | Read conversation from any slice. Use \`range: { type: "last", count: 5 }\` for the latest turns. Verify what the user actually said. |
| \`readAgentTimeline(sliceId)\` | Read agent cognition from any slice. Understand what you were thinking during past turns. |
| \`readPreviously(sliceId)\` | Read previously.md from a past slice. Compare historical beliefs. Check if a belief was present 3 slices ago (R6). |

\`previouslyOutput\` — call LAST with your mutations (or empty array) + a short reasoning note.`;
}

// ─── Pro call ──────────────────────────────────────────────────────────

async function attemptCall(
  prompt: string,
  input: PreviouslyAgentInput,
): Promise<{ mutations: PreviouslyMutation[]; reasoning: string }> {
  const result = await generateText({
    model: createModel(input.model),
    prompt,
    temperature: 0.1,
    stopWhen: isStepCount(5),
    tools: {
      readSlice: tool({
        description:
          "Read the conversation record (core.md) from a specific slice. " +
          "Use this to verify what the user actually said, or to explore a closed slice. " +
          "Use the optional range parameter to fetch only recent turns.",
        inputSchema: z.object({
          sliceId: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format."),
          range: z.object({
            type: z.enum(["turns", "last", "date"]).describe(
              "turns = specific turn indices. last = most recent N. date = after a timestamp.",
            ),
            indices: z.array(z.number()).optional().describe("For type 'turns'."),
            count: z.number().optional().describe("For type 'last'."),
            after: z.string().optional().describe("ISO 8601 timestamp. For type 'date'."),
          }).optional().describe("Optional range filter."),
        }),
        execute: async ({ sliceId, range }) => {
          try { return await input.readSliceFn(sliceId, range); }
          catch { return `(slice not found: ${sliceId})`; }
        },
      }),
      readAgentTimeline: tool({
        description:
          "Read agent.md for a specific slice — the agent's reasoning and tool calls during that slice.",
        inputSchema: z.object({
          sliceId: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format."),
        }),
        execute: async ({ sliceId }) => {
          try { return await input.readAgentTimelineFn(sliceId); }
          catch { return `(agent.md not available for ${sliceId})`; }
        },
      }),
      readPreviously: tool({
        description:
          "Read previously.md from a specific past slice. " +
          "Compare against the current version to track belief evolution across slices. " +
          "Use for R6 (check if a short-term item appears in 3+ slices) or R11 (resolve contradictions).",
        inputSchema: z.object({
          sliceId: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format."),
        }),
        execute: async ({ sliceId }) => {
          try { return await input.readPreviouslyFn(sliceId); }
          catch { return `(previously.md not available for ${sliceId})`; }
        },
      }),
      previouslyOutput: tool({
        description:
          "REQUIRED — call this LAST to report your mutations. " +
          "Call with empty mutations array if nothing needs changing.",
        inputSchema: outputSchema,
      }),
    },
    toolChoice: "auto",
    // No thinking — the worker runs this structured review task without reasoning.
    providerOptions: workerProviderOptions(input.model.sdk),
  });

  const outputCall = result.toolCalls?.find((tc) => tc.toolName === "previouslyOutput");
  if (outputCall?.input) {
    const parsed = outputSchema.safeParse(outputCall.input);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn(
      "[PreviouslyAgent] Output schema validation failed:",
      parsed.error.issues,
    );
    return { mutations: [], reasoning: "Schema validation failed" };
  }

  if (result.text?.trim()) {
    console.warn("[PreviouslyAgent] Pro returned text instead of tool call:", result.text.slice(0, 200));
  }
  return { mutations: [], reasoning: result.text?.slice(0, 200) ?? "Pro did not call output tool" };
}

const RETRY_DELAY_MS = 300;

/**
 * Run the Previously Agent. Never throws — returns empty mutations on failure.
 */
export async function runPreviouslyAgent(
  input: PreviouslyAgentInput,
): Promise<PreviouslyAgentOutput> {
  const prompt = buildPrompt(input);

  try {
    const result = await attemptCall(prompt, input);
    return { mutations: result.mutations, reasoning: result.reasoning };
  } catch (firstError) {
    console.warn("[PreviouslyAgent] First attempt failed, retrying:", firstError instanceof Error ? firstError.message : firstError);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await attemptCall(prompt, input);
      return { mutations: result.mutations, reasoning: result.reasoning };
    } catch {
      return { mutations: [], reasoning: "Previously Agent Pro unavailable" };
    }
  }
}
