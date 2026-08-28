/**
 * Direction Agent — Phase 1 of the two-phase evolution loop (v1.0 design
 * §2.2–§2.3): evaluate whether `memory/evolution/direction.md` should move.
 *
 * The direction doc is the loop's LEARNED REWARD MODEL — its current best
 * theory of what the environment (the user) rewards. The card and playbooks
 * are PRODUCTS evolved under this theory (Phase 2). What it holds are
 * CONDITIONAL MAPPINGS ("when the user is in state-type X, prefer Y"), never
 * states themselves — a mapping stays true in a month, a state goes stale
 * (states belong to the card's Now section). This agent runs at slice
 * boundaries when any bucket triggered (or for the BOOTSTRAP — the first-ever
 * direction, which gets a lowered evidence bar), reads the current direction +
 * the card's Self-model section (promotion candidates: rules on probation) +
 * recent fitness events + this slice's analysis, and answers the narrow
 * question: does the theory itself need to move? Low frequency, high bar by
 * design — "no change" is the common and correct output; a proposal must
 * clear the writing discipline BOTH in the prompt and in code
 * (validateDirectionProposal):
 *
 *   - MAPPINGS, NOT STATES — conditional rules only; episodic facts ("the
 *     user hiked yesterday") are card material and never direction material;
 *   - EVIDENCE-ANCHORED — the Evidence section carries slice pointers
 *     (validated structurally: ≥2 distinct slices steady-state, ≥1 on the
 *     bootstrap write);
 *   - STRUCTURE-OPEN — new dimensions may grow; the four-section skeleton
 *     (Direction / Anti-goals / Evidence / Log) is fixed (validated
 *     structurally);
 *   - REVERSIBLE — there is no "progress" axis, only fit to the current
 *     environment; an old mapping SHOULD retire when the environment turns.
 *     Only the Log section is append-only.
 *
 * The agent only PROPOSES — it holds no write tools. The caller (housekeeping)
 * applies an accepted proposal through writeDirection + the mutations archive,
 * keeping this module side-effect-free and the single-writer discipline in
 * exactly one place.
 *
 * Runs on the shared sub-agent runner (main model, thinking ON at low effort)
 * with a fully static system prompt; everything per-call goes in the user
 * prompt. Never throws — any failure degrades to { outcome: "failed" } and the
 * caller proceeds to Phase 2 with the existing direction.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import type { FitnessEvent } from "./store";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";

// ─── Proposal validation (the code-level half of the writing discipline) ────

/** The fixed four-section skeleton (design §2.2) — structure-open means new
 *  dimensions may grow WITHIN it, not that the skeleton itself moves. */
export const DIRECTION_SECTIONS = [
  "# Direction",
  "# Anti-goals",
  "# Evidence",
  "# Log",
] as const;

/** Hard cap on the direction doc — it is quoted into Phase-2 prompts. */
export const DIRECTION_MAX_CHARS = 8000;

/** A slice id (YYYY-MM-DD-HHMM) — the Evidence section's pointer format. */
const SLICE_ID_RE = /\b\d{4}-\d{2}-\d{2}-\d{4}\b/g;

export type DirectionValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a proposed direction document. Structural checks only — abstract-
 * ness itself is the agent's discipline (enforced by the role prompt); code
 * enforces what code can: the fixed skeleton, the evidence bar (steady-state
 * needs ≥2 DISTINCT slice pointers — the cross-slice requirement; the
 * bootstrap write, the first-ever direction, clears with ≥1), the size cap,
 * and that the proposal actually changes something.
 */
export function validateDirectionProposal(
  proposed: string,
  current: string | null,
  opts?: { bootstrap?: boolean },
): DirectionValidation {
  const text = proposed.trim();
  if (!text) return { ok: false, reason: "proposal is empty" };
  if (text.length > DIRECTION_MAX_CHARS) {
    return {
      ok: false,
      reason: `proposal exceeds the ${DIRECTION_MAX_CHARS}-char cap (${text.length})`,
    };
  }
  for (const section of DIRECTION_SECTIONS) {
    if (!text.includes(section)) {
      return { ok: false, reason: `missing the fixed "${section}" section` };
    }
  }
  const pointers = new Set(text.match(SLICE_ID_RE) ?? []);
  const minPointers = opts?.bootstrap ? 1 : 2;
  if (pointers.size < minPointers) {
    return {
      ok: false,
      reason: opts?.bootstrap
        ? "no slice pointer (YYYY-MM-DD-HHMM) — even the first direction must be evidence-anchored"
        : `direction conclusions must be cross-slice: found ${pointers.size} distinct slice pointer(s), need ≥2`,
    };
  }
  if (current !== null && current.trim() === text) {
    return { ok: false, reason: "proposal is identical to the current direction" };
  }
  return { ok: true };
}

// ─── The sub-agent ──────────────────────────────────────────────────────────

export interface DirectionAgentInput {
  /** The turn's MAIN model (shared runner, thinking ON at low effort). */
  model: ModelConfig;
  /** Current direction.md content — null when never set (fresh deployment). */
  current: string | null;
  /**
   * "bootstrap" = the first-ever direction (template/unset): a lowered
   * evidence bar applies (≥1 slice pointer) and the prompt asks for a minimal
   * baseline. "steady" = the normal high bar (≥2 distinct slice pointers).
   */
  mode: "bootstrap" | "steady";
  /** The card's Self-model section verbatim — the promotion candidates
   *  ("rules on probation"). Null when the card has none. */
  cardSelfModel: string | null;
  /** Recent fitness events, all buckets, newest first or last — rendered
   *  verbatim into the prompt; the caller bounds the count (~30). */
  recentEvents: FitnessEvent[];
  /** This slice's analyzer output — the freshest evidence. */
  analysis: TurnAnalysis;
  /** The slice whose boundary triggered this evaluation. */
  sliceId: string;
}

export type DirectionAgentResult =
  | { outcome: "no_change"; reason: string }
  | {
      outcome: "proposed";
      /** The validated new direction.md content. */
      direction: string;
      reason: string;
      /** Archive fields (design §2.7) — the caller writes the mutation record. */
      summary: string;
      evidence: string[];
      expectedBenefit: string;
    }
  | { outcome: "failed"; reason: string };

const directionReportSchema = z.object({
  outcome: z
    .enum(["no_change", "propose"])
    .describe(
      '"no_change" is the COMMON case — the bar for moving the direction is high. ' +
        '"propose" only when the evidence across slices says the direction itself is wrong or missing something.',
    ),
  reason: z
    .string()
    .describe("1-2 sentences: why no change, or why the direction must move."),
  proposed: z
    .object({
      content: z
        .string()
        .describe(
          "The FULL new direction.md — the four fixed sections (# Direction / # Anti-goals / " +
            "# Evidence / # Log), every entry a CONDITIONAL MAPPING (\"when state-type X, " +
            "prefer Y\"), never a state; the Evidence section carrying slice pointers " +
            "(YYYY-MM-DD-HHMM — ≥2 distinct slices steady-state, ≥1 for the first-ever " +
            "direction).",
        ),
      summary: z
        .string()
        .describe("One line: what changed in the direction (for the mutations archive)."),
      evidence: z
        .array(z.string())
        .describe("Slice pointers / user quotes backing the change."),
      expectedBenefit: z
        .string()
        .describe("One line: what improves for the user if this direction holds."),
    })
    .optional()
    .describe("REQUIRED when outcome is \"propose\"; omit otherwise."),
});

type DirectionReport = z.infer<typeof directionReportSchema>;

/**
 * Static role block — the system prompt (shared base + this) never changes
 * between calls; all per-call content (current direction, fitness events, the
 * slice's analysis) goes in the user prompt.
 */
const DIRECTION_ROLE = `You are the Direction Agent — Phase 1 of the evolution loop. You guard direction.md, the loop's LEARNED REWARD MODEL: its current best theory of what the environment (the user) rewards. The user card and the sub-agent playbooks are PRODUCTS evolved under this theory (Phase 2, a different agent); you only judge whether the THEORY itself should move.

## What direction.md holds — conditional mappings, never states

Write CONDITIONAL MAPPINGS ("when the user is in state-type X, prefer Y"), never the state itself. A mapping stays true in a month (the condition simply doesn't fire when absent); a state ("the user is job-hunting right now") goes stale — states belong to the card's Now section, never here. Episodic facts are card material, NEVER direction material.

## The promotion ladder

A single explicit user directive belongs to the card's Self-model — the fast lane: it takes effect immediately and can be revoked by one new utterance. It is NOT direction material by itself. You promote a pattern into direction only when it RECURS across slices or keeps being corroborated by later reactions. The card's current Self-model lines (provided below) are your promotion candidates — read them as "rules on probation".

## The bar — low frequency, high threshold

"no_change" is the common and correct outcome. The inertia is a noise filter, not loyalty to the past: one loud slice, however loud, is Phase-2 material (the card, a playbook). The theory moves when evidence says the current theory is wrong, drifted, or missing a dimension. When in doubt: no_change.

## Reversal is legal

There is no "progress" axis, only fit to the current environment — when the environment turns, an old mapping SHOULD be retired (a species that loses its exoskeleton hasn't gone backwards). Never let the Log bind the present: the Log is append-only (add a line, never rewrite old lines), everything else may move.

## Bootstrap mode (the FIRST direction)

When the mode below says BOOTSTRAP: the doc has never been written. Seed a minimal, honest, abstract baseline from the card's Self-model and the fitness events at hand. For this first version only, a single slice pointer suffices; steady-state writes need ≥2 distinct slice pointers in Evidence.

## Writing discipline (validated in code — a proposal that violates it is rejected)

1. MAPPINGS, NOT STATES — conditional rules only; no episodic facts, no current-state descriptions.
2. EVIDENCE-ANCHORED — the Evidence section carries slice pointers (YYYY-MM-DD-HHMM): ≥2 distinct slices steady-state, ≥1 on the bootstrap write.
3. STRUCTURE-OPEN — you may grow new dimensions WITHIN the fixed skeleton (# Direction / # Anti-goals / # Evidence / # Log). Anti-goals are the drift guardrails: strengthen them when you see drift; never silently drop one.

## What you get

The current direction.md (or the untouched template in bootstrap mode), the card's Self-model section (promotion candidates), the newest fitness events across all buckets (score: -2 explicit complaint / -1 dissatisfaction / +1 approval, each with the user's verbatim evidence), and this slice's analysis (including its emotional signal). That is all — you have no read tools; judge from this evidence.

Report through directionReport: outcome "no_change" + reason, or outcome "propose" with the full new document.`;

const DIRECTION_SYSTEM = buildSubAgentSystem(DIRECTION_ROLE);

/** How many recent fitness events the prompt carries (all buckets). */
export const DIRECTION_RECENT_EVENTS = 30;

/** Compact render of this slice's analyzer output — the freshest evidence. */
function renderAnalysis(analysis: TurnAnalysis): string {
  const lines = [
    `intent: ${analysis.intent?.type ?? "(none)"} — ${analysis.intent?.reason ?? ""}`,
    `memory_worthy: ${analysis.memoryWorthy}`,
    `emotional_signal: ${analysis.emotionalSignal.intensity}/${analysis.emotionalSignal.register ?? "neutral"} — ${analysis.emotionalSignal.note}`,
  ];
  if (analysis.memoryUpdate) {
    lines.push(`memory_update: ${analysis.memoryUpdate.content}`);
  }
  if (analysis.evolveCard) {
    lines.push(
      `evolve_card: worth=${analysis.evolveCard.worth} — ${analysis.evolveCard.reason}`,
    );
  }
  if (analysis.closedMarking) {
    lines.push(
      `closed slice marking: ${analysis.closedMarking.focus} — ${analysis.closedMarking.summary} (tone ${analysis.closedMarking.tone ?? "?"})`,
    );
  }
  if (analysis.fitness && analysis.fitness.length > 0) {
    lines.push("this slice's fitness deltas:");
    for (const f of analysis.fitness) {
      lines.push(`- ${f.bucket} ${f.delta}: "${f.evidence}"`);
    }
  }
  return lines.join("\n");
}

/** The dynamic user prompt: mode + current direction + Self-model + fitness
 *  events + analysis. */
function buildDirectionPrompt(input: DirectionAgentInput): string {
  const events =
    input.recentEvents.length > 0
      ? input.recentEvents
          .map(
            (e) =>
              `- [${e.ts}] slice ${e.sliceId} · ${e.bucket} ${e.delta > 0 ? `+${e.delta}` : e.delta} — "${e.evidence}"`,
          )
          .join("\n")
      : "(no fitness events recorded yet)";
  return `## Mode: ${input.mode === "bootstrap" ? "BOOTSTRAP — the direction has never been written; seed the minimal baseline (a single slice pointer suffices)" : "steady — the normal high bar (Evidence needs ≥2 distinct slice pointers)"}

## Current direction.md

${input.current?.trim() || "(not set yet — this would be the FIRST direction)"}

## The card's Self-model section (promotion candidates — rules on probation)

${input.cardSelfModel?.trim() || "(empty — no probation rules on the card yet)"}

## Recent fitness events (all buckets, newest ${input.recentEvents.length})

${events}

## This slice's analysis (slice ${input.sliceId})

${renderAnalysis(input.analysis)}

Evaluate: does the THEORY itself need to move? "no_change" is the common case — say so plainly. Promote only what the evidence corroborates.`;
}

const MAX_STEPS = 1;
const TIMEOUT_MS = 60_000;

/**
 * Run the direction evaluation. Never throws: runner failures degrade to
 * { outcome: "failed" } (the caller proceeds to Phase 2 with the existing
 * direction), and a structurally invalid proposal degrades to
 * { outcome: "no_change" } with the rejection reason logged — a bad direction
 * write is worse than a skipped one.
 */
export async function runDirectionAgent(
  input: DirectionAgentInput,
): Promise<DirectionAgentResult> {
  const res = await runSubAgent<DirectionReport>({
    model: input.model,
    system: DIRECTION_SYSTEM,
    prompt: buildDirectionPrompt(input),
    tools: {
      directionReport: tool({
        description:
          "Report the direction evaluation: no_change (the common case) or a full proposed direction.md.",
        inputSchema: directionReportSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "directionReport",
    reportSchema: directionReportSchema,
    maxSteps: MAX_STEPS,
    timeoutMs: TIMEOUT_MS,
  });

  if (!res.ok) {
    return {
      outcome: "failed",
      reason: res.error ?? "Direction Agent failed",
    };
  }
  const report = res.report;
  if (!report) {
    return { outcome: "failed", reason: "directionReport missing or invalid" };
  }
  if (report.outcome === "no_change" || !report.proposed) {
    if (report.outcome === "propose" && !report.proposed) {
      console.warn("[DirectionAgent] outcome=propose without a proposal — treated as no_change");
    }
    return { outcome: "no_change", reason: report.reason };
  }

  const validation = validateDirectionProposal(
    report.proposed.content,
    input.current,
    { bootstrap: input.mode === "bootstrap" },
  );
  if (!validation.ok) {
    // A rejected proposal is NOT a failure of the phase — it is the writing
    // discipline doing its job. Log it loudly, evolve nothing.
    console.warn(`[DirectionAgent] proposal rejected: ${validation.reason}`);
    return {
      outcome: "no_change",
      reason: `proposal rejected (${validation.reason})`,
    };
  }
  return {
    outcome: "proposed",
    direction: report.proposed.content.trim(),
    reason: report.reason,
    summary: report.proposed.summary,
    evidence: report.proposed.evidence,
    expectedBenefit: report.proposed.expectedBenefit,
  };
}
