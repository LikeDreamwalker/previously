/**
 * Direction — the evolution loop's USER PORTRAIT + HYPOTHESIS POOL
 * (`memory/evolution/direction.md`).
 *
 * The direction doc describes WHO THE USER IS — it never instructs the agent.
 * Its fixed four-section skeleton:
 *
 *   - `# Portrait`    — CONFIRMED understanding of the user: descriptive,
 *     abstract, concept-level statements about what kind of person they are
 *     and what works/fails with them ("用户不喜欢感性的回答" is the right level;
 *     "用户不喜欢我说哈哈哈" is too specific). NO imperative behavior rules —
 *     direction describes the USER, never tells the agent what to do. Every
 *     entry stays evidence-anchored with slice pointers (YYYY-MM-DD-HHMM).
 *   - `# Hypotheses`  — a bounded pool of GUESSES (≤ DIRECTION_HYPOTHESES_MAX),
 *     each line carrying structured metadata:
 *       - [proposed YYYY-MM-DD-HHMM · checked YYYY-MM-DD-HHMM] <guess> — falsify if: <condition>
 *     Lifecycle: confirmed (≥2 distinct slices' evidence, or explicit user
 *     confirmation) → PROMOTED into Portrait; refuted → REMOVED (logged);
 *     unverified for >10 slices beyond its `checked` pointer → RETIRED
 *     (logged, re-proposable on new evidence). Every evolution run refills
 *     the pool up to the cap.
 *   - `# Evidence`    — the slice pointers backing Portrait entries.
 *   - `# Log`         — append-only: direction changes AND hypothesis
 *     promotions / refutations / retirements.
 *
 * The card and playbooks are PRODUCTS evolved under this portrait (the merged
 * self-evolution agent, previously-agent.ts, evaluates the direction FIRST and
 * then evolves the card + triggered-bucket playbooks under the possibly-new
 * one — a single run replaced the old two-phase split). The frequency
 * protection the split provided is preserved IN CODE: a proposal must clear
 * the writing discipline BOTH in the prompt and here
 * (validateDirectionProposal):
 *
 *   - DESCRIPTIVE, NEVER IMPERATIVE — the portrait describes the user; a line
 *     that tells the agent what to do is misspelled and must be rephrased as
 *     the user pattern that motivates it;
 *   - EVIDENCE-ANCHORED — the Evidence section carries slice pointers
 *     (validated structurally: ≥2 distinct slices steady-state, ≥1 on the
 *     bootstrap write AND on a migrate re-shape);
 *   - FIXED SKELETON + BOUNDED POOL — the four sections are fixed, and the
 *     hypothesis pool is capped with structured per-line metadata (both
 *     validated structurally);
 *   - REVERSIBLE — there is no "progress" axis, only fit to the current user;
 *     an old portrait entry SHOULD retire when the user changes. Only the Log
 *     section is append-only.
 *
 * The agent only PROPOSES — it holds no write tools. The caller applies an
 * accepted proposal through writeDirection + the mutations archive, keeping
 * this module side-effect-free and the single-writer discipline in exactly
 * one place.
 *
 * `runDirectionAgent` is the legacy STANDALONE evaluator (kept for the bridge
 * path's contract parity; the merged evolution run is the primary flow). It
 * runs on the shared sub-agent runner (main model, thinking ON at low effort)
 * with a fully static system prompt; everything per-call goes in the user
 * prompt. Never throws — any failure degrades to { outcome: "failed" }.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import { isDirectionTemplate, type FitnessEvent } from "./store";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";

// ─── Proposal validation (the code-level half of the writing discipline) ────

/** The fixed four-section skeleton — the portrait + the hypothesis pool. */
export const DIRECTION_SECTIONS = [
  "# Portrait",
  "# Hypotheses",
  "# Evidence",
  "# Log",
] as const;

/** Hard cap on the direction doc — it is quoted into the main agent's system
 *  prompt (Portrait + Hypotheses) and into the evolution agent's prompt. */
export const DIRECTION_MAX_CHARS = 12000;

/** The hypothesis pool's bound — a guess that can't earn its slot is noise. */
export const DIRECTION_HYPOTHESES_MAX = 10;

/**
 * The three evaluation modes:
 *   - "bootstrap" — the FIRST-ever direction (template/unset): a lowered
 *     evidence bar applies (≥1 slice pointer);
 *   - "migrate"   — the doc exists but still uses the OLD skeleton
 *     (# Direction / # Anti-goals): the whole doc is being re-shaped, so the
 *     same lowered bar applies;
 *   - "steady"    — the normal high bar (≥2 distinct slice pointers).
 */
export type DirectionMode = "bootstrap" | "migrate" | "steady";

/**
 * Detect the evaluation mode from the current document: never-written (or the
 * untouched template) → bootstrap; an old-skeleton doc (a `# Direction` or
 * `# Anti-goals` heading) → migrate; anything else → steady.
 */
export function detectDirectionMode(current: string | null): DirectionMode {
  if (isDirectionTemplate(current)) return "bootstrap";
  if (/^# (Direction|Anti-goals)\s*$/m.test(current ?? "")) return "migrate";
  return "steady";
}

/** A slice id (YYYY-MM-DD-HHMM) — the Evidence section's pointer format. */
const SLICE_ID_RE = /\b\d{4}-\d{2}-\d{2}-\d{4}\b/g;

/**
 * A hypothesis line's structured metadata (tolerant): the proposed/checked
 * slice pointers in brackets and a `falsify if:` clause.
 *   - [proposed 2026-08-20-1430 · checked 2026-08-22-1015] <guess> — falsify if: …
 */
const HYPOTHESIS_LINE_RE =
  /^-\s*\[proposed\s+\d{4}-\d{2}-\d{2}-\d{4}\s*[·;|]\s*checked\s+\d{4}-\d{2}-\d{2}-\d{4}\]\s*\S[\s\S]*falsify if:\s*\S/i;

/**
 * Extract one top-level section's body (between its `# Heading` line and the
 * next top-level heading / EOF). Null when the heading is absent.
 */
export function extractDirectionSection(
  doc: string,
  heading: string,
): string | null {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("# ")) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

export type DirectionValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * A section body's SUBSTANCE: "" when the section is absent or carries only a
 * `_(…)` placeholder line (the template's "(Not set yet…" markers). Shared by
 * the L1b renderer (buildDirectionBlock) and the proposal validator so the two
 * can never drift apart on what "empty" means — a doc the renderer would show
 * as NOTHING must not pass validation.
 */
export function directionSubstance(section: string | null): string {
  return section && !section.trimStart().startsWith("_(") ? section.trim() : "";
}

/**
 * Validate a proposed direction document. Structural checks only — the
 * descriptive/imperative discipline itself is the agent's (enforced by the
 * role prompt); code enforces what code can: the fixed skeleton, SUBSTANCE
 * (Portrait and Hypotheses cannot BOTH be empty/placeholder — such a doc would
 * land, flip the mode to steady so the bootstrap/migrate gate goes dark, yet
 * render as no L1b layer at all), the hypothesis pool's bound + per-line
 * metadata, the evidence bar (steady-state needs ≥2 DISTINCT slice pointers —
 * the cross-slice requirement; bootstrap and migrate writes clear with ≥1),
 * the size cap, and that the proposal actually changes something.
 */
export function validateDirectionProposal(
  proposed: string,
  current: string | null,
  opts?: { mode?: DirectionMode },
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
  // Substance (every mode, bootstrap/migrate included): a proposal whose
  // Portrait AND Hypotheses are both empty or placeholder-only carries NO
  // direction — but landing it would flip detectDirectionMode to steady,
  // permanently silencing the bootstrap/migrate gate while buildDirectionBlock
  // keeps returning "" (L1b absent, the analyzer rubric gone forever).
  const portraitSubstance = directionSubstance(
    extractDirectionSection(text, "# Portrait"),
  );
  const hypSubstance = directionSubstance(
    extractDirectionSection(text, "# Hypotheses"),
  );
  if (!portraitSubstance && !hypSubstance) {
    return {
      ok: false,
      reason:
        "no substantive content — # Portrait and # Hypotheses are both empty/placeholder; an empty direction is not a direction",
    };
  }
  // The hypothesis pool: bounded, and every guess carries its metadata.
  const hypSection = extractDirectionSection(text, "# Hypotheses") ?? "";
  const hypLines = hypSection
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
  if (hypLines.length > DIRECTION_HYPOTHESES_MAX) {
    return {
      ok: false,
      reason: `too many hypotheses (${hypLines.length}) — the pool is capped at ${DIRECTION_HYPOTHESES_MAX}`,
    };
  }
  for (const line of hypLines) {
    if (!HYPOTHESIS_LINE_RE.test(line)) {
      return {
        ok: false,
        reason:
          `malformed hypothesis line "${line.slice(0, 60)}${line.length > 60 ? "…" : ""}" — ` +
          'expected "- [proposed YYYY-MM-DD-HHMM · checked YYYY-MM-DD-HHMM] <guess> — falsify if: <condition>"',
      };
    }
  }
  const pointers = new Set(
    (extractDirectionSection(text, "# Evidence") ?? "").match(SLICE_ID_RE) ?? [],
  );
  const lowered = opts?.mode === "bootstrap" || opts?.mode === "migrate";
  const minPointers = lowered ? 1 : 2;
  if (pointers.size < minPointers) {
    return {
      ok: false,
      reason: lowered
        ? "no slice pointer (YYYY-MM-DD-HHMM) — even a bootstrap/migrate direction must be evidence-anchored"
        : `portrait conclusions must be cross-slice: found ${pointers.size} distinct slice pointer(s), need ≥2`,
    };
  }
  if (current !== null && current.trim() === text) {
    return { ok: false, reason: "proposal is identical to the current direction" };
  }
  return { ok: true };
}

// ─── The system-prompt layer (the main agent reads the portrait per turn) ──

/**
 * Build the direction layer of the MAIN agent's system prompt (between the L1
 * card and the L2 static rules): the Portrait as the user model, plus the
 * hypothesis pool explicitly headed as UNVERIFIED GUESSES. Returns "" when the
 * direction is missing, still the template, or carries no portrait/hypothesis
 * content (e.g. a legacy-skeleton doc awaiting migration) — the layer is then
 * omitted entirely.
 */
export function buildDirectionBlock(direction: string | null): string {
  if (isDirectionTemplate(direction)) return "";
  const portrait = directionSubstance(
    extractDirectionSection(direction ?? "", "# Portrait"),
  );
  const hypotheses = directionSubstance(
    extractDirectionSection(direction ?? "", "# Hypotheses"),
  );
  if (!portrait && !hypotheses) return "";
  const parts = [
    "## Direction — who the user is (evolved portrait)",
    "",
    portrait || "(no confirmed portrait entries yet)",
  ];
  if (hypotheses) {
    parts.push(
      "",
      "### Hypotheses — UNVERIFIED GUESSES",
      "",
      "The lines below are guesses about the user, NOT established facts — they may be probed gently (asking the user is allowed), never asserted as fact:",
      "",
      hypotheses,
    );
  }
  return parts.join("\n");
}

// ─── Shared evidence rendering (the standalone agent + the merged run) ─────

/** A closed slice's close-marking — one row of the recent episodic trail the
 *  portrait must stay consistent with (from the timeline catalog). */
export interface DirectionMarking {
  /** Slice id (YYYY-MM-DD-HHMM). */
  id: string;
  focus: string;
  summary: string;
  tone?: string;
}

/** Compact render of a slice's analyzer output — the freshest evidence. */
export function renderDirectionAnalysis(analysis: TurnAnalysis): string {
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

/** The newest fitness events, rendered for a direction prompt. */
export function renderDirectionEvents(recentEvents: FitnessEvent[]): string {
  return recentEvents.length > 0
    ? recentEvents
        .map(
          (e) =>
            `- [${e.ts}] slice ${e.sliceId} · ${e.bucket} ${e.delta > 0 ? `+${e.delta}` : e.delta} — "${e.evidence}"`,
        )
        .join("\n")
    : "(no fitness events recorded yet)";
}

/** The recent closed-slice marking trail, rendered for a direction prompt. */
export function renderDirectionMarkings(
  recentMarkings: DirectionMarking[] | undefined,
): string {
  return recentMarkings && recentMarkings.length > 0
    ? recentMarkings
        .map(
          (m) =>
            `- ${m.id} · ${m.focus} — ${m.summary} (tone ${m.tone ?? "?"})`,
        )
        .join("\n")
    : "(no marked slices yet)";
}

/** A validated-in-caller direction proposal (the merged run's finish tool and
 *  the bridge report both carry this shape). */
export interface DirectionProposal {
  content: string;
  summary: string;
  evidence: string[];
  expectedBenefit: string;
}

// ─── The standalone sub-agent (legacy path — the merged run is primary) ────

export interface DirectionAgentInput {
  /** The turn's MAIN model (shared runner, thinking ON at low effort). */
  model: ModelConfig;
  /** Current direction.md content — null when never set (fresh deployment). */
  current: string | null;
  /** bootstrap / migrate / steady — see DirectionMode. */
  mode: DirectionMode;
  /** The card's legacy Self-model section verbatim — rules to MIGRATE into the
   *  Portrait (descriptive phrasing, keep slice refs). Null when none. */
  cardSelfModel: string | null;
  /** Recent fitness events, all buckets, newest first or last — rendered
   *  verbatim into the prompt; the caller bounds the count (~30). */
  recentEvents: FitnessEvent[];
  /** This slice's analyzer output — the freshest evidence. */
  analysis: TurnAnalysis;
  /** Recent closed slices' markings, newest first — the episodic trail the
   *  portrait is calibrated against (this slice's own marking already rides
   *  `analysis.closedMarking`, so the caller excludes it). Optional: omitted
   *  when the catalog is unreadable. */
  recentMarkings?: DirectionMarking[];
  /** The slice whose boundary triggered this evaluation. */
  sliceId: string;
  /** Live-line callback — the caller (housekeeping) wires this onto the
   *  data-evolution channel so the evaluation's reasoning streams onto the
   *  evolution card. Raw per-delta; the caller owns throttling. */
  onLine?: (line: string, stage: "thinking" | "writing") => void;
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
        '"propose" only when the evidence across slices says the portrait itself is wrong or missing something.',
    ),
  reason: z
    .string()
    .describe("1-2 sentences: why no change, or why the direction must move."),
  proposed: z
    .object({
      content: z
        .string()
        .describe(
          "The FULL new direction.md — the four fixed sections (# Portrait / # Hypotheses / " +
            "# Evidence / # Log): the Portrait DESCRIPTIVE and concept-level (never imperatives), " +
            "each Hypotheses line \"- [proposed YYYY-MM-DD-HHMM · checked YYYY-MM-DD-HHMM] <guess> " +
            "— falsify if: <condition>\" (≤10), the Evidence section carrying slice pointers " +
            "(≥2 distinct slices steady-state, ≥1 for bootstrap/migrate).",
        ),
      summary: z
        .string()
        .describe("One line: what changed in the direction (for the mutations archive)."),
      evidence: z
        .array(z.string())
        .describe("Slice pointers / user quotes backing the change."),
      expectedBenefit: z
        .string()
        .describe("One line: what improves for the user if this portrait holds."),
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
const DIRECTION_ROLE = `You are the Direction Agent — you guard direction.md, the evolution loop's USER PORTRAIT + HYPOTHESIS POOL. The doc describes WHO THE USER IS; it NEVER instructs the agent. The user card (facts and states) and the sub-agent playbooks are evolved under this portrait by the merged self-evolution run; you only judge whether the portrait itself should move.

## What direction.md holds

- \`# Portrait\` — CONFIRMED understanding of the user: descriptive, abstract, concept-level statements about what kind of person they are and what works/fails with them. "用户不喜欢感性的回答" is the right abstraction level; "用户不喜欢我说哈哈哈" is too specific. NO imperative behavior rules — the portrait describes the USER, it never tells the agent what to do. Every entry stays evidence-anchored with slice pointers (YYYY-MM-DD-HHMM).
- \`# Hypotheses\` — a bounded pool of GUESSES about the user (≤10). Each line carries structured metadata: \`- [proposed YYYY-MM-DD-HHMM · checked YYYY-MM-DD-HHMM] <the guess> — falsify if: <condition>\`.
- \`# Evidence\` — the slice pointers backing Portrait entries.
- \`# Log\` — append-only: direction changes AND hypothesis promotions / refutations / retirements.

## The hypothesis lifecycle

- CONFIRMED (evidence from ≥2 distinct slices, or explicit user confirmation) → PROMOTE into the Portrait (descriptive phrasing) and log it.
- REFUTED → REMOVE from the pool and log it.
- UNVERIFIED for >10 slices beyond its \`checked\` pointer → RETIRE it (logged — it may be re-proposed later on new evidence).
- Every evaluation refills the pool toward 10 with fresh guesses grounded in the evidence at hand; a guess with no falsification condition is not a hypothesis.

## The anti-convergence rule

If a line tells the agent what to do ("you should/shouldn't…", "always/never…"), it is MISSPELLED — phrase the USER PATTERN that motivates it instead ("the user reacts badly to X", "the user prefers Y"). A single explicit, durable user statement becomes a Portrait entry DIRECTLY, still descriptive ("用户明确不喜欢 X"). Recurrent patterns promote from the hypothesis pool or from recurrent fitness evidence; single-slice impressions stay hypotheses.

## Legacy migration (the card's old Self-model)

The card no longer carries a Self-model section. When the input below carries legacy Self-model lines — or the mode says MIGRATE (the doc still uses the old # Direction / # Anti-goals skeleton) — fold them into the Portrait: rewrite each as a DESCRIPTIVE statement about the user, keep its slice refs, never as an instruction.

## The bar — low frequency, high threshold

"no_change" is the common and correct outcome. The inertia is a noise filter, not loyalty to the past: one loud slice, however loud, is card/playbook material. The portrait moves when evidence says the current picture is wrong, drifted, or missing something. When in doubt: no_change.

## Bootstrap / migrate modes

BOOTSTRAP = the doc has never been written: seed a minimal, honest, abstract baseline. MIGRATE = the doc exists in the old skeleton: re-shape it wholesale into the new one. Both carry a lowered evidence bar (a single slice pointer suffices); steady-state writes need ≥2 distinct slice pointers in Evidence.

## Reversal is legal

There is no "progress" axis, only fit to the current user — when the user changes, an old portrait entry SHOULD be retired. Never let the Log bind the present: the Log is append-only (add a line, never rewrite old lines), everything else may move.

## Writing discipline (validated in code — a proposal that violates it is rejected)

1. DESCRIPTIVE, NEVER IMPERATIVE — the portrait describes the user; instructions are misspelled patterns.
2. EVIDENCE-ANCHORED — slice pointers (YYYY-MM-DD-HHMM): ≥2 distinct slices steady-state, ≥1 on bootstrap/migrate.
3. FIXED SKELETON + BOUNDED POOL — # Portrait / # Hypotheses / # Evidence / # Log; ≤10 hypothesis lines, each with the proposed/checked metadata and a falsify-if condition.

## What you get

The current direction.md (or the untouched template in bootstrap mode), the card's legacy Self-model lines (migration source), the newest fitness events across all buckets (score: -2 explicit complaint / -1 dissatisfaction / +1 approval, each with the user's verbatim evidence), this slice's analysis (including its emotional signal), and the recent closed slices' markings — the episodic trail your portrait must stay consistent with. That is all — you have no read tools; judge from this evidence.

Report through directionReport: outcome "no_change" + reason, or outcome "propose" with the full new document.`;

const DIRECTION_SYSTEM = buildSubAgentSystem(DIRECTION_ROLE);

/** How many recent fitness events the prompt carries (all buckets). */
export const DIRECTION_RECENT_EVENTS = 30;

/** How many recent closed-slice markings the prompt carries. */
export const DIRECTION_RECENT_MARKINGS = 10;

/** The dynamic user prompt: mode + current direction + legacy Self-model +
 *  fitness events + analysis + the recent marking trail. */
function buildDirectionPrompt(input: DirectionAgentInput): string {
  const modeLine =
    input.mode === "bootstrap"
      ? "BOOTSTRAP — the direction has never been written; seed the minimal baseline (a single slice pointer suffices)"
      : input.mode === "migrate"
        ? "MIGRATE — the doc still uses the OLD skeleton (# Direction / # Anti-goals); re-shape it wholesale into # Portrait / # Hypotheses / # Evidence / # Log (a single slice pointer suffices)"
        : "steady — the normal high bar (Evidence needs ≥2 distinct slice pointers)";
  return `## Mode: ${modeLine}

## Current direction.md

${input.current?.trim() || "(not set yet — this would be the FIRST direction)"}

## Legacy Self-model lines on the card (to MIGRATE into the Portrait — descriptive phrasing, keep their slice refs; the card drops the section)

${input.cardSelfModel?.trim() || "(none — the card carries no legacy Self-model lines)"}

## Recent fitness events (all buckets, newest ${input.recentEvents.length})

${renderDirectionEvents(input.recentEvents)}

## Recent closed-slice markings (newest ${input.recentMarkings?.length ?? 0})

${renderDirectionMarkings(input.recentMarkings)}

These are what the recent slices were ABOUT — ground the portrait and the hypotheses in this trail (an entry cites slice pointers from here), but never copy a slice's state into the direction.

## This slice's analysis (slice ${input.sliceId})

${renderDirectionAnalysis(input.analysis)}

Evaluate: does the PORTRAIT itself need to move? "no_change" is the common case — say so plainly. Promote only what the evidence corroborates; refill the hypothesis pool with honest, falsifiable guesses.`;
}

/** Wall-clock budget — a single forced report call, but thinking on a slow
 *  model can easily exceed a minute (the old 60s cap was the main source of
 *  silent "failed" outcomes). Aligned with the recall colleague's budget. */
const TIMEOUT_MS = 240_000;

/**
 * Run the standalone direction evaluation. Uncapped steps (the report is a
 * single forced tool call anyway); the wall-clock budget above is the bound.
 * Never throws: runner failures degrade to { outcome: "failed" }, and a
 * structurally invalid proposal degrades to { outcome: "no_change" } with the
 * rejection reason logged — a bad direction write is worse than a skipped one.
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
    timeoutMs: TIMEOUT_MS,
    onLine: input.onLine,
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
    { mode: input.mode },
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
