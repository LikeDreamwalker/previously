/**
 * Previously Agent — the "brain" that maintains previously.md (v3).
 *
 * The document is an INCREMENTAL ARCHIVE with two sections:
 *   1. User profile     — third-person inference model of the user, not event
 *      memory. Fixed dimensions, every entry carries `refs` to evidence.
 *   2. Self-model — operating lessons distilled from the agent's own timeline
 *      (agent.md).
 *
 * Each evolution pass evaluates ONLY the recent exchange (current user message
 * + previous agent reply + previous user message) against the current archive:
 * is there new information, a contradiction, or something that changed? Past
 * content stays untouched unless the new evidence refutes it. No re-derivation
 * from history, no wholesale re-synthesis.
 *
 * A separate `reformat` output handles version/format drift: when the current
 * document deviates significantly from the required structure below, the agent
 * rewrites the whole document to spec.
 *
 * Uses the WORKER model (cheap tier) without thinking. Output is structured via
 * the `previouslyOutput` tool call.
 */

import { generateText, tool, isStepCount } from "ai";
import { z } from "zod";
import { createModel } from "@/lib/models/provider";
import { workerProviderOptions } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";
import {
  PROFILE_DIMENSIONS,
  SELF_MODEL_DIMENSIONS,
  PROFILE_DIMENSION_LABELS,
  SELF_MODEL_DIMENSION_LABELS,
} from "@/lib/episodic/previously-format";

// ─── Allowed mutation subsections = union of profile + self-model dimensions ─

export const ALL_SUBSECTIONS = [
  ...PROFILE_DIMENSIONS,
  ...SELF_MODEL_DIMENSIONS,
] as const;
export type Subsection = (typeof ALL_SUBSECTIONS)[number];

export type Section = "profile" | "self_model";

// ─── Types ──────────────────────────────────────────────────────────────

export type PreviouslySignal =
  | "new_observation"
  | "user_correction"
  | "slice_closed"
  | "self_reflection";

export interface PreviouslyMutation {
  action: "observe" | "reinforce" | "contradict" | "discard" | "expire" | "promote" | "demote";
  section: Section;
  subsection: Subsection;
  belief?: string;
  belief_key?: string;
  evidence_slice?: string;
  evidence_turn?: string;
  note?: string;
  new_confidence?: "high" | "medium" | "low";
  refuted_by?: string;
}

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
  /** The recent exchange (last user message + prev agent reply + prev user message). */
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

export interface PreviouslyAgentOutput {
  mutations: PreviouslyMutation[];
  /** When present (format/version drift), the executor replaces the document wholesale. */
  reformat?: string;
  reasoning: string;
}

// ─── Structured output schema ──────────────────────────────────────────

const outputSchema = z.object({
  mutations: z
    .array(
      z.object({
        action: z
          .enum(["observe", "reinforce", "contradict", "discard", "expire", "promote", "demote"])
          .describe("What to do with this entry."),
        section: z
          .enum(["profile", "self_model"])
          .describe("profile = user profile (about the user). self_model = operating self-model (about the agent's own operation)."),
        subsection: z
          .enum(ALL_SUBSECTIONS)
          .describe(
            "Which dimension. Profile: identity|personality|communication|cognition|knowledge|values|work_style|goals|current_state|boundaries. " +
            "Self-model: tool_discipline|reasoning|answer_form|recurring_errors|recall_discipline|corrections.",
          ),
        belief: z.string().optional().describe(
          "Full entry text. Required for: observe, promote, demote.",
        ),
        belief_key: z.string().optional().describe(
          "Key phrase to match an existing entry. Required for: reinforce, contradict, discard, expire, promote, demote.",
        ),
        evidence_slice: z.string().optional().describe(
          "Slice path YYYY/MM/DD/HHMM for the evidence pointer.",
        ),
        evidence_turn: z.string().optional().describe(
          "Turn ID within the evidence slice. Omit for agent.md refs.",
        ),
        note: z.string().optional().describe("Explanation for contradict, discard, or expire."),
        new_confidence: z.enum(["high", "medium", "low"]).optional().describe(
          "New confidence when promoting or demoting.",
        ),
        refuted_by: z.string().optional().describe(
          "For contradict: one line on what refuted this entry (e.g. a user correction).",
        ),
      }),
    )
    .describe("Incremental mutations to apply. Empty array [] = nothing to change."),
  reformat: z
    .object({
      content: z.string().describe("The FULL rewritten previously.md, conforming to the required v3 structure."),
    })
    .optional()
    .describe(
      "ONLY when the current document deviates significantly from the required structure " +
      "(legacy format, missing sections, unknown subsection headers, entries without refs). " +
      "Rewrites the whole document to spec. Otherwise omit and use mutations.",
    ),
  reasoning: z.string().describe("1-3 sentences for the developer log. Not shown to the core agent."),
});

// ─── Dimension specs for the prompt ──────────────────────────────────────

const PROFILE_DIMENSION_SPECS: Record<(typeof PROFILE_DIMENSIONS)[number], string> = {
  identity: "verifiable facts: profession, role, background, how the user is addressed.",
  personality: "personality & decision style: cautious/intuitive, risk tolerance, planning tendency.",
  communication: "communication preferences: direct vs detailed, code-first vs explanation-first, tone, language.",
  cognition: "cognitive style: analytical/intuitive, research-then-verify, learns by doing.",
  knowledge: "domain knowledge & experience: mark seniority per domain (expert / familiar / novice).",
  values: "values & priorities: what the user optimizes for (correctness/speed/learning/autonomy), what they won't compromise.",
  work_style: "work style: project cadence, whether they jump between projects, background loops vs inline answers.",
  goals: "goals & current direction: long-term goals, what they are building.",
  current_state: "current state (short-lived, expiring): what is happening now, near-term plans.",
  boundaries: "boundaries & sensitivities: what the user dislikes, corrected behaviors. Keep few.",
};

const SELF_MODEL_DIMENSION_SPECS: Record<(typeof SELF_MODEL_DIMENSIONS)[number], string> = {
  tool_discipline: "tool discipline: which tools to avoid calling in which situations, tool-selection heuristics.",
  reasoning: "reasoning & decomposition: when thinkDeep is worth it, how to decompose, which effort works.",
  answer_form: "answer form: what structure / length / opening the user accepts.",
  recurring_errors: "recurring errors: repeated mistakes, hallucination-prone areas, habits to verify first.",
  recall_discipline: "recall discipline: when to recall instead of answering from context, when to verify evidence.",
  corrections: "correction record: behaviors the user corrected (the most valuable raw material).",
};

// ─── Prompt ────────────────────────────────────────────────────────────

function buildPrompt(input: PreviouslyAgentInput): string {
  const {
    signal, note, currentSliceId, closedSliceId, previouslyContent,
    agentCognition, recentTurns, currentSliceTags,
  } = input;

  const signalLabels: Record<PreviouslySignal, string> = {
    new_observation: "new_observation — a new round of conversation happened; check for new information",
    user_correction: "user_correction — the user said something in previously.md is wrong",
    slice_closed: "slice_closed — a time slice just closed, good moment for a deeper review",
    self_reflection: "self_reflection — the core agent thinks its strategy needs adjustment",
  };

  const deepNote = closedSliceId
    ? `\n**DEEP MODE**: slice \`${closedSliceId}\` just closed. You may read its conversation and agent.md for patterns worth promoting or demoting.`
    : "";

  const tagsNote = currentSliceTags && currentSliceTags.length > 0
    ? `\n**Current slice tags**: ${currentSliceTags.join(", ")}`
    : "";

  const profileDimTable = PROFILE_DIMENSIONS.map(
    (d) => `- \`${d}\` (subsection header in the document: ${PROFILE_DIMENSION_LABELS[d]}) — ${PROFILE_DIMENSION_SPECS[d]}`,
  ).join("\n");

  const selfModelDimTable = SELF_MODEL_DIMENSIONS.map(
    (d) => `- \`${d}\` (subsection header in the document: ${SELF_MODEL_DIMENSION_LABELS[d]}) — ${SELF_MODEL_DIMENSION_SPECS[d]}`,
  ).join("\n");

  return `You are the Previously Agent — the "brain" that maintains previously.md, the agent's incremental archive. You do NOT talk to users. You work autonomously.

## What previously.md is

An ARCHIVE with two sections:
1. **User profile** — a third-person inference model of the user. NOT event memory.
2. **Self-model** — operating lessons about how the agent itself handles things.

## Signal

${signalLabels[signal]}
Note from core agent: "${note}"${tagsNote}
Current slice: \`${currentSliceId}\`${deepNote}

## Incremental center — the ONLY basis for your judgment

You evaluate ONLY the recent conversation below against the current archive. You do NOT re-scan history, do NOT re-derive past content, do NOT re-synthesize the whole document from scratch. Past entries stay untouched unless the new evidence in this exchange contradicts them.

## Required structure

### Section 1 — User profile (subsection → what may be written)

${profileDimTable}

**Profiling principle:** each entry is a stable inference or trait, described from a third-person view. It is NOT a log of events. "The user likes movies" belongs here; "the user watched a movie yesterday" does NOT — that stays in the time slice, and is only referenced via refs. Never log events.

### Section 2 — Self-model (subsection → what may be written)

${selfModelDimTable}

**Self-model principle:** entries come from the agent's own handling — tool use, answer structure, reasoning, errors. Anchor on FAILURE: tool failures, user corrections/interruptions, timeouts, inefficient multi-step paths. What to do differently next time.

### Entry format (every section)

Each entry is ONE line of text + an indented meta line:
- One-line claim
  refs: [YYYY/MM/DD/HHMM-turnId], [agent.md YYYY/MM/DD/HHMM] | confidence: high | obs: N

- \`refs\` — REQUIRED on every entry: at least one evidence pointer (slice-turn, or \`agent.md <slice>\` for self-model lessons).
- \`confidence\` — high/medium/low.
- \`obs\` — how many times observed.
- \`expires\` — required for \`current_state\` / \`boundaries\` entries (default: ~14 days).

## Rules

1. **Write in English.** Every entry text is written in English, even when the user writes in another language. The user's own words stay in the time slice; the archive is read by the agent in English.
2. **No refs, no write.** Every observe/promote must cite evidence_slice + evidence_turn. You cannot invent refs — if there is no evidence, don't write.
3. **No duplicates.** Same concept as an existing entry → reinforce (obs++), not a new entry.
4. **User correction / contradiction** → contradict the old entry (drop confidence, set \`refuted_by\` to the correction), then observe the corrected belief if warranted. Never leave both a claim and its refutation as equally-valid entries.
5. **Change in a stable trait** → the old entry is marked \`superseded_by\` (contradict + observe with a note), not physically deleted.
6. **Short-lived entries** (current_state / boundaries) carry \`expires\`; expired ones → expire.
7. **Promote/demote** move an entry between current_state and a stable dimension when its nature changes (keeps recurring → promote; now just current context → demote).
7b. **Never write HTML comments in the document.** No \`<!-- ... -->\` anywhere in belief text or meta. A superseded/refuted claim is expressed STRUCTURALLY: \`contradict\` it (set \`refuted_by\` to the correction), or \`discard\` it — never by appending a note inside the entry text.
8. **Bounds** (also enforced by code): profile ≤ 40 entries total, self_model ≤ 30 entries total. When over, the weakest (low confidence, stale) are evicted — prefer to evict the weakest yourself rather than adding to an overflowing section.
9. **Staleness.** A stable entry (any dimension) whose \`updated\` date is roughly 2+ weeks older than the current slice has likely drifted from the user's present state: demote its confidence one level, or \`discard\` it if it is clearly no longer true. Entries past their \`expires\` date must be \`expire\`d. Do not let stale stable entries sit at full confidence indefinitely.
10. **No new information** → call \`previouslyOutput\` with an empty mutations array IMMEDIATELY. Do NOT call any tools.

## Reformat (format/version drift)

FIRST, check whether the current previously.md conforms to the required structure above. If it deviates SIGNIFICANTLY, output \`reformat\` with the FULL document rewritten to this spec (and leave mutations empty):
- Legacy format (still contains the old v2 headers like "## 长期记忆" / "## 短期记忆")
- Missing the current section headers (## User profile / ## Self-model)
- Subsection headers that are not in the dimension lists above
- Entries without \`refs\` / confidence
- Entries not written in English

If the document already conforms, use incremental \`mutations\` only.

## Current previously.md (the document you mutate)

${previouslyContent || "(empty template — this is a new slice. Start from the structure above.)"}

## Agent Cognition (current slice's agent.md — raw material for self-model lessons)

${agentCognition || "(no cognition yet — this is the first turn in this slice)"}

## Recent Conversation (your only window into what changed)

${recentTurns.length > 0
  ? recentTurns.map((t) => `**${t.role}**: ${t.content}`).join("\n\n")
  : "(No recent conversation provided.)"}

## Your Process

1. Quick scan of the recent conversation against the archive. New information about the user? Contradictions? Expired current_state entries? A self-model lesson (tool failure / correction)?
2. If the document deviates from the required structure → output \`reformat\`.
3. Else if changes are warranted → output \`mutations\` (incremental).
4. Else → \`previouslyOutput({ mutations: [], reasoning: "..." })\` immediately, no tools.

**Semantic merging:** the same concept in different languages (e.g. "self-evolution" and "自我进化") is ONE belief — reinforce, never duplicate.

## Your Tools

| Tool | When to use |
|------|-------------|
| \`readSlice(sliceId, range?)\` | Read conversation from any slice. Verify what the user actually said. |
| \`readAgentTimeline(sliceId)\` | Read agent cognition from any slice. Understand what you were thinking. |
| \`readPreviously(sliceId)\` | Read a past slice's previously.md. Check whether an entry has been consistently held. |

\`previouslyOutput\` — call LAST with your mutations (or empty array) + a short reasoning note.`;
}

// ─── Worker call ──────────────────────────────────────────────────────────

async function attemptCall(
  prompt: string,
  input: PreviouslyAgentInput,
): Promise<{ mutations: PreviouslyMutation[]; reformat?: string; reasoning: string }> {
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
          "Compare against the current version to check how long an entry has been held.",
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
          "REQUIRED — call this LAST to report your mutations and/or reformat. " +
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
      const d = parsed.data;
      return {
        mutations: d.mutations,
        reformat: d.reformat?.content,
        reasoning: d.reasoning,
      };
    }
    console.warn(
      "[PreviouslyAgent] Output schema validation failed:",
      parsed.error.issues,
    );
    return { mutations: [], reasoning: "Schema validation failed" };
  }

  if (result.text?.trim()) {
    console.warn("[PreviouslyAgent] Worker returned text instead of tool call:", result.text.slice(0, 200));
  }
  return { mutations: [], reasoning: result.text?.slice(0, 200) ?? "Worker did not call output tool" };
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
    return { mutations: result.mutations, reformat: result.reformat, reasoning: result.reasoning };
  } catch (firstError) {
    console.warn("[PreviouslyAgent] First attempt failed, retrying:", firstError instanceof Error ? firstError.message : firstError);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await attemptCall(prompt, input);
      return { mutations: result.mutations, reformat: result.reformat, reasoning: result.reasoning };
    } catch {
      return { mutations: [], reasoning: "Previously Agent worker unavailable" };
    }
  }
}
