/**
 * Turn Analyzer — the single structured sub-agent call inside the
 * housekeeping step.
 *
 * One pass, structured outputs (thinking on at low effort, cheap):
 *   1. message_tags   — keyword tags for the current user message (woven into strands).
 *   2. semantic_hint  — which EXISTING strands this message is about, plus why
 *      (an LLM understands paraphrase / cross-language). v0.9: no longer fed
 *      into the prompt (the per-turn priming block was retired with the
 *      slice-level prompt freeze); kept on the analysis record for
 *      housekeeping decisions and agent.md.
 *   3. closed_marking — focus / summary / refined tags / tone for a slice that is
 *      about to close (only when one closed this turn).
 *   4. evolve_card    — whether the closing slice holds anything worth
 *      sedimenting onto the user card (only when one closed this turn).
 *   5. fitness        — this slice's evidence-anchored satisfaction deltas per
 *      bucket (v1.0 design §2.5 — the analyzer SCORES, never aggregates; the
 *      deterministic trigger math lives in src/lib/evolution/triggers.ts).
 *      This slice's mechanical signals (recall verify/rework, §2.6) are an
 *      input, each recall_rework/recall_repeat a -1 candidate for recall.
 *
 * The model is passed in — since v0.9 it is the turn's MAIN model, run through
 * the shared sub-agent runner (src/lib/agents/sub-agent-runner.ts): thinking
 * ON at effort "low", a 30s wall-clock budget, a fully static system prompt
 * (shared base + role) with all dynamic content in the user prompt. Never
 * throws — returns an empty analysis on any failure so housekeeping degrades
 * gracefully (no marking, no hint → engineering fallbacks kick in).
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import type { EmotionalTone, Turn } from "@/lib/episodic/types";
import type { EmotionalSignal } from "@/lib/turn-priming";
import type { FitnessBucket, FitnessSignal } from "@/lib/evolution/store";

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

/** Best-fit card section for an explicit memory update (v5 card sections). */
export const CARD_SECTIONS = ["identity", "past", "now", "horizon", "self_model"] as const;
export type CardSection = (typeof CARD_SECTIONS)[number];

/**
 * One fitness delta for one bucket (v1.0 design §2.5). The analyzer SCORES,
 * the code aggregates — a delta is only ever a single, evidence-anchored
 * observation about THIS slice; the sliding-window trigger math lives in
 * src/lib/evolution/triggers.ts. An evidence-less non-zero delta is
 * force-zeroed at the store boundary (appendFitnessEvents).
 */
export interface FitnessDelta {
  bucket: FitnessBucket;
  delta: -2 | -1 | 0 | 1;
  /** The user's EXACT words backing a non-zero delta (or the supplied
   *  mechanical-signal detail for a recall -1 candidate). */
  evidence: string;
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
  /**
   * Whether this turn holds durable information worth persisting. False for
   * trivial turns (greetings / "继续" / thanks) — the engineering layer then
   * skips tag extraction and strand writes.
   */
  memoryWorthy: boolean;
  /**
   * The user's emotional register this turn — how emotionally weighted the
   * message is and its dominant register (distress, humor, excitement, …).
   * The main agent reads it from the turn brief to lead with support or match
   * the user's register instead of staying purely analytical. Always present;
   * defaults to neutral on analysis failure.
   */
  emotionalSignal: EmotionalSignal;
  /**
   * Present only when the user EXPLICITLY asked to record/evolve ("记住：…",
   * "自进化", "更新前情提要") OR stated an explicit BEHAVIORAL CORRECTION /
   * durable preference ("以后别…", "下次先…", "你不要总是…", "stop doing X").
   * Carries the exact content to fold into the card.
   */
  memoryUpdate?: { content: string; section?: CardSection };
  /**
   * Present ONLY when a slice was closing this turn (closingSlice input): the
   * worker's judgment on whether anything in the closing slice deserves
   * sedimentation onto the user card. On analyzer failure the fallback is
   * worth: true — a wasted worker call is cheap, a missed evolution is
   * permanent memory loss.
   */
  evolveCard?: { worth: boolean; reason: string };
  closedMarking?: ClosedMarking;
  /**
   * This slice's fitness deltas (design §2.5), 0-5 entries. Absent entirely
   * when nothing in the slice explicitly signaled satisfaction or
   * dissatisfaction — "no signal" means NO entry, not a 0-entry.
   */
  fitness?: FitnessDelta[];
}

export interface AnalyzeTurnInput {
  /** The model to run this analysis on (the turn's MAIN model, via the runner). */
  model: ModelConfig;
  userMessage: string;
  existingStrandNames: string[];
  /** Present only when a slice is about to close this turn — enables Task 3. */
  closingSlice?: { turns: Turn[]; tags: string[] };
  /**
   * This slice's mechanical fitness signals (design §2.6 — recall
   * verify/rework instrumentation). Each recall_rework / recall_repeat is a
   * -1 CANDIDATE for the recall bucket in Task 7; its detail may serve as
   * the evidence.
   */
  signals?: FitnessSignal[];
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
  memory_worthy: z.boolean().describe(
    "Whether this turn contains durable, persistable information (a new fact about the user, " +
    "a preference, a correction, or a substantive exchange). Trivial turns — greetings, " +
    "acknowledgments, 'continue', 'ok', thanks, small talk — are false. Controls whether tags " +
    "are extracted and memory evolves.",
  ),
  memory_update: z
    .object({
      content: z.string().describe(
        "The EXACT durable fact/preference/correction the user stated, in English — third person " +
        "about the user ('User prefers…'), first person about the agent ('Always summarize before " +
        "answering').",
      ),
      section: z
        .enum(CARD_SECTIONS)
        .optional()
        .describe(
          "Best-fit card section: identity | past | now | horizon | self_model. Omit when unsure.",
        ),
    })
    .optional()
    .describe(
      "Set when the user EXPLICITLY asked to record something or run self-evolution " +
      "('记住：…', '自进化', '更新前情提要', 'record this') OR stated an explicit BEHAVIORAL " +
      "CORRECTION / durable preference the agent should evolve from immediately " +
      "('以后别…', '下次先…', '你不要总是…', 'stop doing X', 'from now on always…'). " +
      "Extract the exact content. Omit otherwise.",
    ),
  evolve_card: z
    .object({
      worth: z
        .boolean()
        .describe(
          "Whether anything in the CLOSING slice deserves sedimentation onto the user card — " +
          "a durable fact, a preference/correction, a commitment or deadline (Horizon), a " +
          "resolvable open loop, or an operating lesson. False only for slices with zero " +
          "card-worthy content (pure greetings, logistics, ephemeral chit-chat).",
        ),
      reason: z.string().describe("One line: what deserves sedimentation, or why nothing does."),
    })
    .optional()
    .describe("ONLY when a slice is closing this turn — judge card-evolution worthiness."),
  emotional_signal: z
    .object({
      intensity: z
        .enum(["none", "light", "strong"])
        .describe(
          "How much emotional weight this message carries. none = purely informational. " +
          "light = mild feeling (small talk, light humor, casual sharing). " +
          "strong = the user is emotionally engaged — frustrated, upset, vulnerable, " +
          "celebrating, seeking support, or sharing something personally significant.",
        ),
      register: z
        .enum(["neutral", "emotional", "humorous", "frustrated", "excited"])
        .optional()
        .describe(
          "The dominant emotional register, when one is present. emotional = sharing feelings / " +
          "seeking support; humorous = joking, playful, sarcastic; frustrated = annoyed or distressed; " +
          "excited = happy, proud, celebrating. Omit or 'neutral' when the message is emotionally neutral.",
        ),
      note: z
        .string()
        .describe(
          "One short line: what the user is feeling and why — a hint for the agent's brief. Empty string when neutral.",
        ),
    })
    .describe(
      "The user's emotional register for the CURRENT message — how emotionally weighted it is and its " +
      "dominant register. The agent uses this to lead with support or match register instead of staying " +
      "purely analytical.",
    ),
  closed_marking: z
    .object({
      focus: z.string().describe("One sentence: what this session was about."),
      summary: z.string().describe("At most 100 characters: what happened / key decisions."),
      tags: z.array(z.string()).max(6).describe("2-6 clean tags, deduped, cross-language merged."),
      tone: z.enum(["positive", "neutral", "negative", "mixed"]).describe("Emotional tone of the session."),
    })
    .optional()
    .describe("Only when a slice just closed."),
  fitness: z
    .array(
      z.object({
        bucket: z
          .enum(["card", "recall", "search", "thinkdeep", "interaction"])
          .describe(
            "What the signal attributes to: card = the user card's content; recall = the " +
            "recall colleague's answers; search = the research colleague; thinkdeep = the " +
            "thinking pod; interaction = the main agent's general conduct.",
          ),
        delta: z
          .union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1)])
          .describe(
            "-2 = explicit complaint/correction; -1 = signs of dissatisfaction; " +
            "+1 = explicit approval. 0 only when you must record a signal-free observation.",
          ),
        evidence: z
          .string()
          .describe(
            "The user's EXACT words (verbatim quote) backing a non-zero delta. No quote → " +
            "do NOT emit the entry. For a recall -1 candidate from a supplied mechanical " +
            "signal, the signal's detail line serves as the evidence — quoting it is allowed.",
          ),
      }),
    )
    // Truncate, never reject: an over-long fitness list must not nuke the
    // whole analysis (same leniency as the bridge report schema).
    .transform((a) => a.slice(0, 5))
    .optional()
    .describe(
      "Fitness scoring (Task 7): ONLY what THIS slice's user messages explicitly signal. " +
      "Nothing signaled → emit NO entry (an absent fitness field, not a 0-delta list).",
    ),
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

/**
 * Static role block — the system prompt (shared base + this) never changes
 * between calls, so provider prefix caches hit on every analysis. All dynamic
 * content (message, existing topics, closing slice) goes into the user prompt.
 */
const ANALYZER_SYSTEM = buildSubAgentSystem(`You are the memory analyzer for a personal AI platform. One pass, seven tasks (Task 6 ONLY when the user message includes a closing slice). Keep every field short — this is metadata, not prose.

## Task 1 — Tag the current message

Return message_tags with TWO parts:
- reuse: existing topic names from the provided list that this message relates to. Pick VERBATIM from the list. Prefer reuse over create — the same concept must never gain a second name.
- create: a NEW durable/general topic ONLY when no existing topic covers this message. Durable = a work/life area, a project, a company, financing, health, a recurring emotional thread. NEVER an ephemeral one-off event ("dreamt", "hungover", "today's errand"). Max 3, each with a one-line reason.

Merge-first rule: reuse > create. If in doubt, reuse an existing topic rather than minting a new one.

## Task 2 — Semantic hint for the agent

Which of the EXISTING topics listed in the user message is this message most likely about? The agent uses this to decide which past slices to recall. Only list topics that are genuinely related; empty if none. One-line reason.
Return semantic_hint: { strands: [...], reason: "..." }

## Task 3 — Classify the user's intent

What is the user trying to do? Pick the single best label and give a one-line reason.
Return intent: { type: "code_debug" | "code_write" | "explain" | "chat" | "review" | "clarify", reason: "..." }

## Task 4 — Judge whether this turn is worth remembering

Is this a substantive exchange that should update memory (a new fact about the user, a preference, a correction, or a real discussion)? Or is it trivial — a greeting, acknowledgment, "继续", "ok", thanks, or small talk?

Return memory_worthy: true only when the turn contains durable information worth tagging and evolving. Trivial turns are false.

If the user EXPLICITLY asked to record something or run self-evolution ("记住：…", "自进化", "更新前情提要", "record this") — OR stated an explicit BEHAVIORAL CORRECTION / durable preference the agent should evolve from immediately ("以后别…", "下次先…", "你不要总是…", "stop doing X", "from now on always…") — regardless of memory_worthy — ALSO return memory_update with the exact content (English) + the best-fit card section. Omit memory_update otherwise.

## Task 5 — Read the emotional register

What is the user's emotional state in this message, if any? The agent reads this to know when to lead with support or match the user's register instead of staying purely analytical.

Return emotional_signal with:
- intensity: none | light | strong — how much emotional weight the message carries (strong = frustrated, upset, vulnerable, celebrating, seeking support, a significant personal matter; light = light humor or casual sharing; none = purely informational)
- register: neutral | emotional | humorous | frustrated | excited — the dominant register; humorous covers joking / playful / sarcastic. Omit or "neutral" when none.
- note: one short line on what the user is feeling and why (empty when neutral).

## Task 6 — Mark the closed slice (ONLY when the user message includes one)

When a time slice just closed, summarize it so future recall can understand it at a glance. Return closed_marking with:
- focus: one sentence on what this session was about
- summary: at most 100 characters — what happened / key decisions
- tags: 2-6 clean tags (dedupe, merge the same concept across languages)
- tone: positive | neutral | negative | mixed

ALSO return evolve_card — your judgment on whether anything in this closing slice deserves sedimentation onto the user card:
- worth: true when the slice contains a durable fact about the user, a stated preference or correction, a commitment / deadline / awaited reply (a Horizon item), the resolution of an open loop, or an operating lesson for the agent
- worth: false ONLY when the slice holds zero card-worthy content — pure greetings, logistics, ephemeral chit-chat
- reason: one line on what deserves sedimentation, or why nothing does
When in doubt, worth: true — a wasted review is cheap, a missed evolution is permanent memory loss.

## Task 7 — Score fitness signals (ONLY what this slice explicitly signals)

Score the user's EXPLICIT satisfaction/dissatisfaction signals in THIS slice, attributed to a bucket. This is the evolution loop's selection pressure — another agent aggregates your deltas; you only report single, evidence-anchored observations.

- Buckets: card (the user card's content), recall (the recall colleague's answers), search (the research colleague), thinkdeep (the thinking pod), interaction (the main agent's general conduct).
- delta: -2 = explicit complaint or correction ("that's wrong", "stop doing X"); -1 = signs of dissatisfaction (frustration, asking again, disappointment); +1 = explicit approval ("exactly what I needed", "记住了真好"). 0 = no signal — but prefer emitting NO entry at all.
- EVIDENCE RULE (hard): every non-zero delta MUST quote the user's exact words in evidence. No quote → do not emit the entry. A delta without evidence is force-zeroed downstream anyway — don't waste it.
- Score ONLY what this slice's user messages say. Never infer satisfaction from your own performance guesses; never score on the agent's behalf.
- Mechanical signals: when the input lists a recall_rework / recall_repeat signal, treat it as a -1 CANDIDATE for the recall bucket (the main agent re-did recall's job — implicit distrust). The signal's detail line may serve as the evidence. recall_verify is neutral — no entry.
- Max 5 entries. Nothing signaled → omit the fitness field entirely.`);

/** The dynamic user prompt: current message, existing topics, closing slice. */
function buildPrompt(input: AnalyzeTurnInput): string {
  const existing =
    input.existingStrandNames.length > 0
      ? input.existingStrandNames.join(", ")
      : "(none yet)";

  const closingSection = input.closingSlice
    ? `

## Closing slice — also run Task 6

A time slice just closed.

Conversation (first turn + last turns):
${compressSliceTurns(input.closingSlice.turns)}

Existing tags on this slice: ${input.closingSlice.tags.join(", ") || "(none)"}

Return closed_marking AND evolve_card per your Task 6 instructions.`
    : "";

  const signalsSection =
    input.signals && input.signals.length > 0
      ? `

## Mechanical signals this slice (Task 7 input)

Instrumentation recorded these this slice (design: recall verify/rework tracking):
${input.signals.map((s) => `- ${s.type} — ${s.detail}`).join("\n")}

Each recall_rework / recall_repeat is a -1 CANDIDATE for the recall bucket (its detail may serve as evidence). recall_verify is neutral — no entry.`
      : "";

  return `Message: "${input.userMessage.slice(0, 1000)}"

Existing topics (pick from these FIRST — they are the durable memory index): ${existing}${closingSection}${signalsSection}`;
}

/**
 * Pure boundary gate: should the LLM card evolution run for this closed slice?
 * The analyzer's `evolveCard.worth` decides; when the analyzer failed (or
 * didn't answer), default to TRUE — a wasted worker call is cheap, a missed
 * evolution is permanent memory loss.
 */
export function shouldRunCardEvolution(
  analysis: Pick<TurnAnalysis, "evolveCard">,
): boolean {
  return analysis.evolveCard?.worth ?? true;
}

const EMPTY_BASE: TurnAnalysis = {
  messageTags: { reuse: [], create: [] },
  semanticHint: { strands: [], reason: "" },
  // Conservative on failure: don't block tag extraction (empty tags are a
  // no-op anyway), so an analyzer outage never silently freezes memory writes.
  memoryWorthy: true,
  emotionalSignal: { intensity: "none", register: "neutral", note: "" },
};

/**
 * The degraded analysis returned on any failure. When a slice was closing,
 * evolveCard defaults to worth: true (see shouldRunCardEvolution).
 */
function emptyAnalysis(sliceClosing: boolean): TurnAnalysis {
  return sliceClosing
    ? {
        ...EMPTY_BASE,
        evolveCard: { worth: true, reason: "Analyzer unavailable — defaulting to evolve." },
      }
    : { ...EMPTY_BASE };
}

export async function analyzeTurn(input: AnalyzeTurnInput): Promise<TurnAnalysis> {
  const sliceClosing = input.closingSlice !== undefined;
  const result = await runSubAgent({
    model: input.model,
    system: ANALYZER_SYSTEM,
    prompt: buildPrompt(input),
    tools: {
      analyzeOutput: tool({
        description: "Report the analysis results.",
        inputSchema: analyzeSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "analyzeOutput",
    reportSchema: analyzeSchema,
    maxSteps: 1,
    timeoutMs: 30_000,
    progress: { toolName: "turn-analyzer" },
  });

  // The runner never throws: a timeout / model failure / missing or invalid
  // report all degrade to the empty analysis (engineering fallbacks kick in).
  if (!result.ok || !result.report) return emptyAnalysis(sliceClosing);

  const d = result.report;
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
      memoryWorthy: d.memory_worthy,
      emotionalSignal: {
        intensity: ["none", "light", "strong"].includes(d.emotional_signal.intensity)
          ? (d.emotional_signal.intensity as EmotionalSignal["intensity"])
          : "none",
        register:
          d.emotional_signal.register &&
          ["neutral", "emotional", "humorous", "frustrated", "excited"].includes(
            d.emotional_signal.register,
          )
            ? (d.emotional_signal.register as EmotionalSignal["register"])
            : "neutral",
        note: typeof d.emotional_signal.note === "string" ? d.emotional_signal.note : "",
      },
      memoryUpdate: d.memory_update
        ? {
            content: d.memory_update.content,
            section: d.memory_update.section,
          }
        : undefined,
      // Only meaningful when a slice is closing; if the model omitted it, the
      // caller's gate (shouldRunCardEvolution) defaults to running.
      evolveCard:
        sliceClosing && d.evolve_card
          ? { worth: d.evolve_card.worth, reason: d.evolve_card.reason }
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
      // Fitness deltas pass through verbatim (capped) — the store boundary
      // (appendFitnessEvents) owns the evidence force-zero backstop; do NOT
      // duplicate it here.
      fitness: d.fitness
        ? d.fitness.slice(0, 5).map((f) => ({
            bucket: f.bucket,
            delta: f.delta,
            evidence: typeof f.evidence === "string" ? f.evidence : "",
          }))
        : undefined,
    };
}
