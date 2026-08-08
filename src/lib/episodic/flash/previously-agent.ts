/**
 * Previously Agent — the "brain" that maintains previously.md (v4 user card).
 *
 * The document is a compact USER CARD:
 *   1. Identity head     — structured, machine-parsed (Name / Address them as / Pronouns).
 *   2. Profile paragraph — ONE rolling third-person description of the user,
 *      updated IN PLACE (preserve unchanged parts verbatim).
 *   3. Recent            — short-lived current-state lines, 7-day expiry.
 *   4. Self-model        — compact operating lessons, DELTA from DIRECTIVES only.
 *
 * Each evolution pass evaluates the recent exchange (or, on slice close, the
 * whole slice) against the current card: is there new information, a change, or
 * something stale? The agent rewrites the card in place — no additive
 * accumulation, no re-derivation from history, no wholesale re-synthesis.
 *
 * Self-model entries must be a DELTA from the standing operating rules
 * (distilled from DIRECTIVES below): restating a rule is forbidden;
 * contradicting one is forbidden unless the user explicitly overrode it
 * (marked `overrides: <rule>` with high confidence + the user's words).
 *
 * Uses the WORKER model (cheap tier) without thinking. Output is structured via
 * the `previouslyOutput` tool call — a single `updated_card` field.
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
  /** Slice the card belongs to. */
  currentSliceId: string;
  /** When a slice just closed, its id (triggers a deeper whole-slice review). */
  closedSliceId?: string;
  /** The current card — pre-loaded by the executor. */
  previouslyContent: string;
  /** Current slice's agent.md — pre-loaded by the executor. */
  agentCognition: string;
  /** The recent exchange (last user msg + prev agent reply + prev user msg). */
  recentTurns: Array<{ role: string; content: string }>;
  /** Tags on the current slice — helps contextualize the conversation. */
  currentSliceTags?: string[];

  // ── Tool implementations (callbacks provided by the executor) ──────

  readSliceFn: (sliceId: string, range?: {
    type: "turns" | "last" | "date";
    indices?: number[];
    count?: number;
    after?: string;
  }) => Promise<string>;
  readAgentTimelineFn: (sliceId: string) => Promise<string>;
  readPreviouslyFn: (sliceId: string) => Promise<string>;
}

export interface PreviouslyAgentOutput {
  /** The FULL updated card text. Empty when nothing changed / on failure. */
  updatedCard: string;
  reasoning: string;
}

// ─── Standing rules (distilled from DIRECTIVES) ──────────────────────────

/**
 * The operating invariants the card's Self-model must never contradict without
 * an explicit user override. Distilled from identity/agent/DIRECTIVES.md so the
 * Previously Agent judges against the same rules the core agent follows.
 */
const STANDING_RULES = [
  "recall and readSlice are the memory tools — always available, never refused",
  "replies use the user's LOCAL time (given each turn), not UTC",
  "complex questions are decomposed into thinkDeep fragments; trivial ones are answered inline",
  "the card and its entries are written in English",
  "every claim in the card carries refs to its evidence slice",
];

// ─── Structured output schema ──────────────────────────────────────────

const outputSchema = z.object({
  updated_card: z.string().describe(
    "The FULL updated previously.md user card. Preserve every unchanged line VERBATIM — only " +
    "add, edit, or remove what the new evidence warrants. Structure:\n" +
    "# Previously On\n_Active slice: {id} | Format: user card | Updated: {iso}_\n\n" +
    "## Identity\n- Name: ... | - Address them as: ... | - Pronouns: ...\n\n" +
    "## Profile\n{ONE flowing third-person paragraph about the user — ≤ ~400 tokens}\n\n" +
    "## Recent\n- {short current-state line} — refs: [...] | since: YYYY-MM-DD   (≤ 5 lines, newest first)\n\n" +
    "## Self-model\n- {compact operating lesson, DELTA from the standing rules}   (≤ 10 lines)\n\n" +
    "Refs stay attached to each claim so the agent can read the evidence slice for detail.",
  ),
  reasoning: z.string().describe("1-3 sentences for the developer log. Not shown to the core agent."),
});

// ─── Prompt ────────────────────────────────────────────────────────────

function buildPrompt(input: PreviouslyAgentInput): string {
  const {
    signal, note, currentSliceId, closedSliceId, previouslyContent,
    agentCognition, recentTurns, currentSliceTags,
  } = input;

  const signalLabels: Record<PreviouslySignal, string> = {
    new_observation: "new_observation — a new round of conversation happened; check for new information",
    user_correction: "user_correction — the user confirmed an explicit memory update",
    slice_closed: "slice_closed — a time slice just closed; review the whole conversation",
    self_reflection: "self_reflection — the core agent thinks its strategy needs adjustment",
  };

  const deepNote = closedSliceId
    ? `\n**DEEP MODE**: slice \`${closedSliceId}\` just closed. You may read its full conversation and agent.md for patterns worth folding into the card.`
    : "";

  const tagsNote = currentSliceTags && currentSliceTags.length > 0
    ? `\n**Current slice tags**: ${currentSliceTags.join(", ")}`
    : "";

  const standingRules = STANDING_RULES.map((r) => `- ${r}`).join("\n");

  return `You are the Previously Agent — the "brain" that maintains previously.md, a compact USER CARD. You do NOT talk to users. You work autonomously.

## What the card is

A compact, bounded snapshot of the user (and how you should operate), NOT an event log and NOT an additive archive:
1. **Identity** — structured head: name, how to address them, pronouns.
2. **Profile** — ONE rolling third-person paragraph describing the user (who they are, how they work, what they prefer). Updated IN PLACE.
3. **Recent** — short-lived current-state lines ("user is evaluating X"), each carrying \`since\`; older than 7 days they are dropped.
4. **Self-model** — compact operating lessons about how you handle things.

The raw evidence lives in the time slices; the card only summarizes and points at them via refs.

## Signal

${signalLabels[signal]}
Note: "${note}"${tagsNote}
Current slice: \`${currentSliceId}\`${deepNote}

## What to do — edit the card IN PLACE

Compare the input below against the current card. Update the card to incorporate anything NEW and durable, and remove anything stale. **Preserve what is still accurate and well-formed** — but the card must read as ONE clean, coherent description. If the current card is fragmented (space-joined fragments, non-English entries, broken structure), REWRITE those parts into canonical form — preserving the substance, improving the form. Do not gratuitously rewrite what is already accurate and well-formed; do not re-derive content from history.

- New stable fact about the user → fold it into the Profile paragraph (or Identity head if it is a name/address fact).
- Current situation that will fade → a Recent line with \`since: <today>\`.
- A user correction / explicit preference → update the Profile paragraph and/or Self-model to reflect it.
- Fragmented or non-English content → rewrite it cleanly: the Profile as ONE flowing English paragraph, every entry in English.
- Nothing new AND the card is already clean → output the card UNCHANGED (verbatim) with a short reasoning.

## Caps (hard — the updater enforces them too)

- Profile paragraph ≤ ~400 tokens. Compress rather than grow.
- Recent ≤ 5 lines, newest first; drop anything older than 7 days.
- Self-model ≤ 10 lines. Identity head ≤ 8 lines.

## Self-model — DELTA from the standing rules

You operate under these standing rules:

${standingRules}

Self-model entries must be a **delta** from them — either:
1. A NEW heuristic the rules do not cover (tool usage, answer form, error patterns), or
2. An explicit USER override of a rule — then mark \`overrides: <rule>\`, set high confidence, and cite the user's own words as evidence.

FORBIDDEN: restating a standing rule as a self-model entry, or recording a lesson that contradicts one without an \`overrides\` marker. Drop such lines.

## Ref entry format

Each claim carries a compact ref line, e.g.:
- \`refs: [2026/08/07/0709]\` (slice id) or \`refs: [2026/08/07/0709-abc123]\` (slice-turn). Never invent refs — no evidence, no write.

## Drill-down

The refs point to the original time slices. The core agent reads the card as standing context; when it needs the actual conversation, it calls \`readSlice\` on the referenced slice. Keep refs accurate so that works.

## Reformat (legacy only)

FIRST check the current card structure. If the document is still the OLD v3 format (headers \`## User profile\` / \`## Self-model\`, or \`### Identity & background\`), rewrite it wholesale into the card structure above. If it is already a card, just edit in place.

## Current card (the document you update)

${previouslyContent || "(empty — new card. Start from the structure above.)"}

## Agent Cognition (current slice's agent.md — raw material for self-model lessons)

${agentCognition || "(no cognition yet — this is the first turn in this slice)"}

## Recent Conversation (your window into what changed)

${recentTurns.length > 0
  ? recentTurns.map((t) => `**${t.role}**: ${t.content}`).join("\n\n")
  : "(No recent conversation provided.)"}

## Your Process

1. Compare the recent conversation against the current card. New durable info? Stale lines? A self-model lesson (tool failure / correction / user preference)?
2. If the document is legacy v3 → rewrite it into the card structure (\`updated_card\`).
3. Else → output the updated card via \`previouslyOutput\` — editing in place, preserving everything unchanged.
4. If nothing changed → output the card verbatim with empty reasoning.
5. Never call \`previouslyOutput\` until you are done reading; it is the LAST call.

**Semantic merging:** the same concept across languages (e.g. "self-evolution" and "自我进化") is ONE fact — merge, never duplicate.

## Your Tools

| Tool | When to use |
|------|-------------|
| \`readSlice(sliceId, range?)\` | Read conversation from any slice. Verify what the user actually said. |
| \`readAgentTimeline(sliceId)\` | Read agent cognition from any slice. Understand what you were thinking. |
| \`readPreviously(sliceId)\` | Read a past slice's card. Check whether a fact has been consistently held. |

\`previouslyOutput\` — call LAST with the full updated card + a short reasoning note.`;
}

// ─── Worker call ──────────────────────────────────────────────────────────

async function attemptCall(
  prompt: string,
  input: PreviouslyAgentInput,
): Promise<{ updatedCard?: string; reasoning: string }> {
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
          "Compare against the current version to check how long a fact has been held.",
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
          "REQUIRED — call this LAST to report the full updated card. " +
          "Output the card unchanged (verbatim) when nothing changed.",
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
      return { updatedCard: parsed.data.updated_card, reasoning: parsed.data.reasoning };
    }
    console.warn(
      "[PreviouslyAgent] Output schema validation failed:",
      parsed.error.issues,
    );
    return { reasoning: "Schema validation failed" };
  }

  if (result.text?.trim()) {
    console.warn("[PreviouslyAgent] Worker returned text instead of tool call:", result.text.slice(0, 200));
  }
  return { reasoning: result.text?.slice(0, 200) ?? "Worker did not call output tool" };
}

const RETRY_DELAY_MS = 300;

/**
 * Run the Previously Agent. Never throws — returns an empty updatedCard on
 * failure so the caller can no-op gracefully.
 */
export async function runPreviouslyAgent(
  input: PreviouslyAgentInput,
): Promise<PreviouslyAgentOutput> {
  const prompt = buildPrompt(input);

  try {
    const result = await attemptCall(prompt, input);
    return { updatedCard: result.updatedCard ?? "", reasoning: result.reasoning };
  } catch (firstError) {
    console.warn("[PreviouslyAgent] First attempt failed, retrying:", firstError instanceof Error ? firstError.message : firstError);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await attemptCall(prompt, input);
      return { updatedCard: result.updatedCard ?? "", reasoning: result.reasoning };
    } catch {
      return { updatedCard: "", reasoning: "Previously Agent worker unavailable" };
    }
  }
}
