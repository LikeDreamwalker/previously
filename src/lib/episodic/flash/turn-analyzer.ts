/**
 * Turn Analyzer — the single worker-model call inside the housekeeping step.
 *
 * One pass, three outputs (structured, thinking off, cheap):
 *   1. message_tags   — keyword tags for the current user message (woven into strands).
 *   2. semantic_hint  — which EXISTING strands this message is about, plus why
 *      (feeds the turn-priming block; an LLM understands paraphrase / cross-language).
 *   3. closed_marking — focus / summary / refined tags / tone for a slice that is
 *      about to close (only when one closed this turn).
 *
 * The model is passed in — it is the resolved WORKER model (see
 * src/lib/models/worker.ts), not the main chat model. Never throws — returns an
 * empty analysis on any failure so housekeeping degrades gracefully (no
 * marking, no hint → engineering fallbacks kick in).
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import { createModel } from "@/lib/models/provider";
import { workerProviderOptions } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";
import type { EmotionalTone, Turn } from "@/lib/episodic/types";

export interface SemanticHint {
  strands: string[];
  reason: string;
}

export interface ClosedMarking {
  focus: string;
  summary: string;
  tags: string[];
  tone: EmotionalTone | null;
}

/** The user's intent for this turn (reconnected from the old router). */
export const INTENT_TYPES = [
  "code_debug",
  "code_write",
  "explain",
  "chat",
  "review",
  "clarify",
] as const;
export type TurnIntent = (typeof INTENT_TYPES)[number];

export interface NewTagProposal {
  tag: string;
  /** Why none of the existing topics covers this. */
  reason: string;
}

export interface TurnAnalysis {
  /**
   * Merge-first tags: `reuse` are existing strand names picked verbatim from
   * the provided list; `create` are genuinely new durable topics (with a
   * reason). The engineering layer folds `create` into existing strands via
   * normalized-match before ever minting a new key.
   */
  messageTags: { reuse: string[]; create: NewTagProposal[] };
  semanticHint: SemanticHint;
  /** The user's intent — what they're trying to do this turn. */
  intent?: { type: TurnIntent; reason: string };
  closedMarking?: ClosedMarking;
}

export interface AnalyzeTurnInput {
  /** The worker model to run this analysis on. */
  model: ModelConfig;
  userMessage: string;
  existingStrandNames: string[];
  /** Present only when a slice is about to close this turn — enables Task 3. */
  closingSlice?: { turns: Turn[]; tags: string[] };
}

const analyzeSchema = z.object({
  message_tags: z
    .object({
      reuse: z
        .array(z.string())
        .max(5)
        .describe(
          "Existing topic names (from the provided list) this message relates to, " +
          "picked verbatim. Prefer reuse over create — merge, don't invent.",
        ),
      create: z
        .array(
          z.object({
            tag: z
              .string()
              .describe(
                "A NEW durable/general topic (e.g. work area, life area, project, company, " +
                "financing, health, an emotional thread) ONLY when no existing topic " +
                "covers this message. Never an ephemeral one-off event.",
              ),
            reason: z
              .string()
              .describe("One line: why none of the existing topics covers this."),
          }),
        )
        .max(3)
        .describe("Genuinely new topics only; empty when reuse suffices."),
    })
    .describe("Merge-first tags for the current message: reuse existing topics, create only when needed."),
  semantic_hint: z.object({
    strands: z
      .array(z.string())
      .max(5)
      .describe("Existing topic names this message is about. Empty if none."),
    reason: z.string().describe("One line: why these topics relate to the message."),
  }),
  intent: z.object({
    type: z.enum(INTENT_TYPES).describe("The user's intent for this turn."),
    reason: z.string().describe("One line: what the user is trying to do."),
  }),
  closed_marking: z
    .object({
      focus: z.string().describe("One sentence: what this session was about."),
      summary: z.string().describe("At most 100 characters: what happened / key decisions."),
      tags: z.array(z.string()).max(6).describe("2-6 clean tags, deduped, cross-language merged."),
      tone: z.enum(["positive", "neutral", "negative", "mixed"]).describe("Emotional tone of the session."),
    })
    .optional()
    .describe("Only when a slice just closed."),
});

/** Compress a closing slice's turns for Task 3 — first turn + last 10, chars capped. */
function compressSliceTurns(turns: Turn[]): string {
  if (turns.length === 0) return "(empty slice)";
  const pick = turns.length <= 11 ? turns : [turns[0], ...turns.slice(-10)];
  const body = pick
    .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
    .join("\n");
  return body.length > 6000 ? body.slice(-6000) : body;
}

function buildPrompt(input: AnalyzeTurnInput): string {
  const existing =
    input.existingStrandNames.length > 0
      ? input.existingStrandNames.join(", ")
      : "(none yet)";

  const closingSection = input.closingSlice
    ? `

## Task 4 — Mark the closed slice

A time slice just closed. Summarize it so future recall can understand it at a glance.

Conversation (first turn + last turns):
${compressSliceTurns(input.closingSlice.turns)}

Existing tags on this slice: ${input.closingSlice.tags.join(", ") || "(none)"}

Return closed_marking with:
- focus: one sentence on what this session was about
- summary: at most 100 characters — what happened / key decisions
- tags: 2-6 clean tags (dedupe, merge the same concept across languages)
- tone: positive | neutral | negative | mixed`
    : "";

  return `You are the memory analyzer for a personal AI platform. One pass, three tasks. Keep every field short — this is metadata, not prose.

## Task 1 — Tag the current message

Message: "${input.userMessage.slice(0, 1000)}"

Existing topics (pick from these FIRST — they are the durable memory index): ${existing}

Return message_tags with TWO parts:
- reuse: existing topic names from the list above that this message relates to. Pick VERBATIM from the list. Prefer reuse over create — the same concept must never gain a second name.
- create: a NEW durable/general topic ONLY when no existing topic covers this message. Durable = a work/life area, a project, a company, financing, health, a recurring emotional thread. NEVER an ephemeral one-off event ("dreamt", "hungover", "today's errand"). Max 3, each with a one-line reason.

Merge-first rule: reuse > create. If in doubt, reuse an existing topic rather than minting a new one.

## Task 2 — Semantic hint for the agent

Which of the EXISTING topics above is this message most likely about? The agent uses this to decide which past slices to recall. Only list topics that are genuinely related; empty if none. One-line reason.
Return semantic_hint: { strands: [...], reason: "..." }

## Task 3 — Classify the user's intent

What is the user trying to do? Pick the single best label and give a one-line reason.
Return intent: { type: "code_debug" | "code_write" | "explain" | "chat" | "review" | "clarify", reason: "..." }${closingSection}`;
}

const EMPTY: TurnAnalysis = {
  messageTags: { reuse: [], create: [] },
  semanticHint: { strands: [], reason: "" },
};

export async function analyzeTurn(input: AnalyzeTurnInput): Promise<TurnAnalysis> {
  try {
    const result = await generateText({
      model: createModel(input.model),
      prompt: buildPrompt(input),
      temperature: 0.1,
      tools: {
        analyzeOutput: tool({
          description: "Report the analysis results.",
          inputSchema: analyzeSchema,
        }),
      },
      toolChoice: "required",
      providerOptions: workerProviderOptions(input.model.sdk),
    });

    const tc = result.toolCalls?.[0];
    if (tc?.toolName !== "analyzeOutput" || !tc.input) return EMPTY;

    const parsed = analyzeSchema.safeParse(tc.input);
    if (!parsed.success) return EMPTY;

    const d = parsed.data;
    return {
      messageTags: {
        reuse: d.message_tags.reuse.slice(0, 5),
        create: d.message_tags.create
          .slice(0, 3)
          .filter((c) => typeof c.tag === "string" && c.tag.trim().length > 0)
          .map((c) => ({ tag: c.tag, reason: c.reason })),
      },
      semanticHint: {
        strands: d.semantic_hint.strands
          .slice(0, 5)
          .filter((s) => typeof s === "string" && s.trim().length > 0),
        reason: typeof d.semantic_hint.reason === "string" ? d.semantic_hint.reason : "",
      },
      intent: d.intent
        ? { type: d.intent.type, reason: d.intent.reason }
        : undefined,
      closedMarking: d.closed_marking
        ? {
            focus: typeof d.closed_marking.focus === "string" ? d.closed_marking.focus.trim() : "",
            summary: typeof d.closed_marking.summary === "string" ? d.closed_marking.summary.trim() : "",
            tags: d.closed_marking.tags.slice(0, 6),
            tone: ["positive", "neutral", "negative", "mixed"].includes(d.closed_marking.tone)
              ? (d.closed_marking.tone as EmotionalTone)
              : null,
          }
        : undefined,
    };
  } catch {
    return EMPTY;
  }
}
