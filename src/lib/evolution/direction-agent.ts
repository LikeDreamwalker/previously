/**
 * Direction Agent — Phase 1 of the two-phase evolution loop (v1.0 design
 * §2.2–§2.3): evaluate whether `memory/evolution/direction.md` should move.
 *
 * The direction doc is the SELECTION CRITERIA of the evolution loop (what
 * "better for the user" means across slices); the card and playbooks are only
 * its products (Phase 2). This agent runs at slice boundaries when any bucket
 * triggered, reads the current direction + the recent fitness events + this
 * slice's analyzer output, and answers the narrow question: does the direction
 * itself need to change? Low frequency, high bar by design — "no change" is
 * the common and correct output; a proposal must clear the writing discipline
 * BOTH in the prompt and in code (validateDirectionProposal):
 *
 *   - ABSTRACT — still true in a month; episodic facts ("the user hiked
 *     yesterday") are card material and never direction material;
 *   - CROSS-SLICE — every conclusion is backed by evidence from multiple
 *     slices, and the Evidence section must carry slice pointers (validated
 *     structurally: no slice id → rejected);
 *   - STRUCTURE-OPEN — new dimensions may grow; the four-section skeleton
 *     (Direction / Anti-goals / Evidence / Log) is fixed (validated
 *     structurally).
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
const SLICE_ID_RE = /\b\d{4}-\d{2}-\d{2}-\d{4}\b/;

export type DirectionValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a proposed direction document. Structural checks only — abstract-
 * ness itself is the agent's discipline (enforced by the role prompt); code
 * enforces what code can: the fixed skeleton, the cross-slice evidence bar
 * (≥1 slice pointer), the size cap, and that the proposal actually changes
 * something.
 */
export function validateDirectionProposal(
  proposed: string,
  current: string | null,
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
  if (!SLICE_ID_RE.test(text)) {
    return {
      ok: false,
      reason: "no slice pointer (YYYY-MM-DD-HHMM) — direction conclusions must be cross-slice, evidence-anchored",
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
            "# Evidence / # Log), every conclusion abstract and cross-slice, the Evidence " +
            "section carrying slice pointers (YYYY-MM-DD-HHMM).",
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
const DIRECTION_ROLE = `You are the Direction Agent — Phase 1 of the evolution loop. You guard direction.md, the cross-slice statement of what "better for the user" means. The user card and the sub-agent playbooks are PRODUCTS evolved under this direction (Phase 2, a different agent); you only judge whether the CRITERIA themselves should move.

## The bar — low frequency, high threshold

"no_change" is the common and correct outcome. Evaluate every time; write almost never. One slice's events, however loud, are Phase-2 material (the card, a playbook) — the direction moves only when evidence ACROSS slices says the current direction is wrong, drifted, or missing a dimension. When in doubt: no_change.

## Writing discipline (validated in code — a proposal that violates it is rejected)

1. ABSTRACT — a direction entry must still be true in a month. Episodic facts ("the user hiked yesterday", "prepping Friday's interview") are card material and NEVER direction material.
2. CROSS-SLICE — every conclusion is backed by evidence from MULTIPLE slices; the Evidence section must carry slice pointers (YYYY-MM-DD-HHMM). A single slice's signal goes to the card/playbooks, not here.
3. STRUCTURE-OPEN — you may grow new dimensions as the evidence demands; the four-section skeleton (# Direction / # Anti-goals / # Evidence / # Log) is fixed. Keep the Log append-only: add a new line for this change, never rewrite old lines.
4. Anti-goals are the drift guardrails — what we must NOT evolve into. Strengthen them when you see drift; never silently drop one.

## What you get

The current direction.md (possibly unset), the newest fitness events across all buckets (score: -2 explicit complaint / -1 dissatisfaction / +1 approval, each with the user's verbatim evidence), and this slice's analysis. That is all — you have no read tools; judge from this evidence.

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

/** The dynamic user prompt: current direction + fitness events + analysis. */
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
  return `## Current direction.md

${input.current?.trim() || "(not set yet — this would be the FIRST direction; the bar is the same: abstract, cross-slice, evidence-anchored)"}

## Recent fitness events (all buckets, newest ${input.recentEvents.length})

${events}

## This slice's analysis (slice ${input.sliceId})

${renderAnalysis(input.analysis)}

Evaluate: does the DIRECTION itself need to change? "no_change" is the common case — say so plainly. Propose only on cross-slice evidence.`;
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
