/**
 * Previously Agent — the "brain" that maintains previously.md (v5 user card).
 *
 * The document is a compact USER CARD with the user's time axis explicit:
 *   1. Identity head — structured, machine-parsed (Name / Address them as / Pronouns / Alias).
 *   2. Past          — ONE rolling third-person profile paragraph (updated IN
 *      PLACE) + durable "anchor facts" (still true in 3 years).
 *   3. Now           — current-state hooks. EXPIRY IS AGENT-OWNED: items older
 *      than 7 days are surfaced with their age; the agent promotes the durable
 *      substance to Past or drops the hook. Nothing is removed mechanically.
 *   4. Horizon       — future-facing open loops (commitments / deadlines /
 *      awaited replies), each with an explicit `by` date. Resolved only by
 *      being fulfilled — never age-expired, overdue items are kept.
 *   5. Self-model    — compact operating lessons, DELTA from DIRECTIVES only.
 *
 * WRITING IS MUTATION-BASED: the agent never outputs the whole card. It edits
 * an in-memory copy through per-entry write tools (addNow / updatePastProfile /
 * resolveHorizon / …) that validate each write and REJECT with compression
 * instructions. The session's LOOP BRAKE (card-session.ts) bounds the
 * re-submission failure mode: the 2nd identical rejection escalates with the
 * exact arithmetic, the 3rd force-lands length violations (truncated) or skips
 * the write with a finish-now instruction. Untouched entries are preserved by
 * construction.
 *
 * Each evolution pass is INCREMENTAL: it evaluates only the new evidence (the
 * recent exchange, or the just-closed slice) against the current card. Past
 * slices are immutable evidence; their reading may be revised by NEW evidence,
 * never re-derived from re-reading the same history.
 *
 * Self-model lessons need BOTH process and outcome evidence: the agent.md
 * timeline shows HOW it thought/acted (error→retry sequences, discarded
 * options), core.md shows what the user actually said and how tools replied.
 * Reasoning proposes, outcomes dispose.
 *
 * Runs on the turn's MAIN model through the shared sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts): thinking ON at low effort, a 90s
 * budget, a 30-step cap, and the `finish` tool as the report channel. When
 * the pass exhausts its steps without calling finish, the mutations that
 * already landed are returned as a PARTIAL result instead of failing.
 * The runner streams the model's thinking/writing live; since this agent does
 * NOT run as a tool call, the lines flow through the optional `onLine`
 * callback (wired by housekeeping onto the `data-evolution` channel).
 */

import { tool } from "ai";
import { z } from "zod";
import type { ModelConfig } from "@/lib/models/registry";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { capPlaybook, type FitnessBucket, type FitnessEvent, type FitnessSignal } from "@/lib/evolution/store";
import type { PlaybookAgent } from "@/lib/evolution/paths";
import {
  parseCard,
  findOverdueHorizonItems,
  CARD_NOW_EXPIRY_DAYS,
  CARD_PROFILE_MAX_CHARS,
  NOW_ITEM_MAX_CHARS,
  HORIZON_ITEM_MAX_CHARS,
  SELF_MODEL_LINE_MAX_CHARS,
  PAST_ANCHOR_MAX_CHARS,
  CARD_NOW_MAX,
  CARD_SELF_MODEL_MAX,
  PAST_ANCHORS_MAX,
  HORIZON_MAX,
} from "../previously-format";
import {
  createCardSession,
  serializeSession,
  sessionSetIdentity,
  sessionUpdatePastProfile,
  sessionAddPastAnchor,
  sessionRemovePastAnchor,
  sessionAddNow,
  sessionRemoveNow,
  sessionPromoteNowToPast,
  sessionAddHorizon,
  sessionResolveHorizon,
  sessionAddSelfModel,
  sessionRemoveSelfModel,
  type CardSession,
} from "../card-session";

// ─── Types ──────────────────────────────────────────────────────────────

export type PreviouslySignal =
  | "new_observation"
  | "slice_closed"
  | "self_reflection";

/**
 * One playbook mutation the agent proposed and the code ACCEPTED (the bucket
 * was triggered). Written to disk by the caller (runCardEvolution) together
 * with its mutations-archive record — this module stays side-effect-free
 * except through the caller-provided reader callbacks.
 */
export interface PlaybookWrite {
  agent: PlaybookAgent;
  /** capPlaybook-capped content — the injection budget is enforced here. */
  content: string;
  evidence: string[];
  expectedBenefit: string;
}

export interface PreviouslyAgentInput {
  signal: PreviouslySignal;
  note: string;
  /** The model running the review — the turn's MAIN model (v0.9 unified runner). */
  model: ModelConfig;
  /** Slice the card belongs to. */
  currentSliceId: string;
  /** When a slice just closed, its id (triggers a deeper whole-slice review). */
  closedSliceId?: string;
  /** The current card — pre-loaded by the executor. */
  previouslyContent: string;
  /** The recent exchange (the closed slice's turns, or the active exchange). */
  recentTurns: Array<{ role: string; content: string }>;
  /** Tags on the current slice — context for the review. */
  currentSliceTags?: string[];
  /** The user's LOCAL calendar date (YYYY-MM-DD) — Now ages / overdue checks
   *  compare against the user's clock, and it is the default `since`. */
  todayLocal?: string;

  // ── Two-phase evolution inputs (v1.0 design §2.3, Phase 2 = product) ──

  /**
   * The current evolution direction (memory/evolution/direction.md) — the
   * CRITERIA the card and playbooks evolve under; the card is the RESULT.
   * Orientation only: null/absent means no direction has been set yet.
   */
  direction?: string | null;
  /**
   * The fitness buckets that TRIGGERED this run (design §2.5 — deterministic,
   * code-level scoring in src/lib/evolution/triggers.ts). Playbook writes are
   * gated on this: writePlaybook REJECTS any agent whose bucket is not listed.
   */
  triggeredBuckets?: FitnessBucket[];
  /** Recent fitness events for the triggered buckets — the evidence to
   *  re-read before deciding what to change (scores are sensors, not judges). */
  fitnessEvents?: FitnessEvent[];
  /** This slice's mechanical signals (recall verify/rework) — context for
   *  recall-bucket triggers. */
  fitnessSignals?: FitnessSignal[];

  // ── Tool implementations (callbacks provided by the executor) ──────

  readSliceFn: (sliceId: string, range?: {
    type: "turns" | "last" | "date";
    indices?: number[];
    count?: number;
    after?: string;
  }) => Promise<string>;
  readAgentTimelineFn: (sliceId: string) => Promise<string>;
  readPreviouslyFn: (sliceId: string) => Promise<string>;

  /**
   * Live-line callback for the agent's streaming thinking/writing — wired by
   * housekeeping onto the `data-evolution` channel (the Previously Agent does
   * not run as a tool call, so the runner's toolCallId emitter is noop).
   * Unthrottled; the caller throttles.
   */
  onLine?: (line: string, stage: "thinking" | "writing") => void;
}

export interface PreviouslyAgentOutput {
  /** The serialized card after the session's mutations. Empty on failure. */
  updatedCard: string;
  reasoning: string;
  /** ONE user-language sentence describing what changed — shown in the UI and
   *  handed to the core agent. Empty when nothing changed. */
  summary: string;
  /** Compact log of every applied mutation ("addNow: …", "resolveHorizon: …"). */
  mutations: string[];
  /**
   * True when the pass ended WITHOUT a finish call (step cap / plain-text
   * stop): `updatedCard` carries whatever mutations landed before the pass
   * stopped. NOT a failure — the caller writes the partial card back.
   */
  partial?: boolean;
  /**
   * True when the agent FAILED (unreachable, timed out) as opposed to
   * legitimately deciding "nothing to update" — the caller must not present
   * a failure as a clean no-change result.
   */
  failed?: boolean;
  /**
   * Accepted playbook mutations (v1.0 §2.4 — one per triggered recall /
   * search / thinkdeep bucket). NOT yet written to disk — the caller applies
   * them (writePlaybook + mutations archive) next to the card write-back.
   */
  playbookWrites?: PlaybookWrite[];
  /** The agent's one-line expected benefit for this pass's changes (design
   *  §2.7 — archived with the mutation record). */
  expectedBenefit?: string;
}

// ─── Standing rules (distilled from DIRECTIVES) ──────────────────────────

/**
 * The operating invariants the card's Self-model must never contradict without
 * an explicit user override. Distilled from identity/agent/DIRECTIVES.md so the
 * Previously Agent judges against the same rules the core agent follows.
 */
const STANDING_RULES = [
  "recall (the episodic-recall colleague) and readSlice (verification only) are the memory tools — always available, never refused",
  "replies use the user's LOCAL time (given each turn), not UTC",
  "thinkDeep is a clean-room thinking pod for isolated, unbiased reasoning — not a default step of every turn",
  "the card and its entries are written in English",
  "every claim in the card carries refs to its evidence slice",
];

// ─── Prompt ────────────────────────────────────────────────────────────
// v0.9 unified sub-agent architecture: the SYSTEM prompt is fully static
// (SHARED_SUBAGENT_BASE + the role block below) so every call shares one
// prefix cache entry; ALL per-call content (time context, signal, the current
// card, the recent conversation) goes in the USER prompt.

const PREVIOUSLY_ROLE = `You are the Previously Agent — the "brain" that maintains previously.md, a compact USER CARD. You do NOT talk to users. You work autonomously.

## What the card is

A compact, bounded snapshot of the user across their time axis (and how you should operate), NOT an event log and NOT an additive archive:
1. **Identity** — structured head: name, how to address them, pronouns, aliases.
2. **Past** — ONE rolling third-person paragraph describing the user (who they are, how they work, what they prefer), updated IN PLACE — plus durable anchor facts.
3. **Now** — current-state semantic compression: short hooks into what is happening right now, each carrying \`since\`. Expiry is YOURS: items past ${CARD_NOW_EXPIRY_DAYS} days are listed in the task — promote durable substance to Past or drop the hook.
4. **Horizon** — future-facing open loops: commitments, deadlines, awaited replies. Each carries an explicit \`by: YYYY-MM-DD\`. Horizon items NEVER age-expire; overdue ones are KEPT until fulfilled.
5. **Self-model** — compact operating lessons about how you handle things.

The raw evidence lives in the time slices; the card only summarizes and points at them via refs.

## How you write — MUTATIONS, never the whole file

You edit an in-memory copy of the card through write tools. Each write is validated: over-limit or malformed writes come back REJECTED with instructions — compress and retry; YOU decide what survives a cap (nothing is ever truncated silently — unless the loop brake force-applies a write you kept resubmitting identically, truncated to the cap). Entries you never touch stay exactly as they are. Removal tools take a \`match\` substring of the entry you mean.

| Tool | When to use |
|------|-------------|
| \`setIdentity(field, value)\` | field ∈ name / address_as / pronouns / alias. Sets or replaces that line. |
| \`updatePastProfile(text)\` | Rewrite the rolling profile paragraph IN PLACE (≤ ${CARD_PROFILE_MAX_CHARS} chars). |
| \`addPastAnchor(text, refs)\` / \`removePastAnchor(match)\` | Durable fact ("still true in 3 years"), ≤ ${PAST_ANCHOR_MAX_CHARS} chars, refs required, ≤ ${PAST_ANCHORS_MAX} total. |
| \`addNow(text, refs, since?)\` / \`removeNow(match)\` / \`promoteNowToPast(match)\` | Current-state hook, ≤ ${NOW_ITEM_MAX_CHARS} chars, refs required, ≤ ${CARD_NOW_MAX} total. \`since\` defaults to today. Promote moves the hook to Past anchors (keeps refs). |
| \`addHorizon(text, by, refs)\` / \`resolveHorizon(match, note?)\` | Open loop, ≤ ${HORIZON_ITEM_MAX_CHARS} chars, \`by: YYYY-MM-DD\` + refs required, ≤ ${HORIZON_MAX} total. Resolve removes it — the ONLY way a Horizon item leaves. |
| \`addSelfModel(text)\` / \`removeSelfModel(match)\` | Operating lesson, ≤ ${SELF_MODEL_LINE_MAX_CHARS} chars, ≤ ${CARD_SELF_MODEL_MAX} total. |
| \`writePlaybook(agent, content, evidence, expectedBenefit)\` | Rewrite a sub-agent colleague's working notes (agent ∈ recall / search / thinkdeep). GATED: accepted ONLY when that colleague's bucket triggered this run (the task lists the triggered buckets) — otherwise REJECTED. |
| \`readSlice(sliceId, range?)\` | Read conversation from any slice. Verify what the user actually said. |
| \`readAgentTimeline(sliceId)\` | Read agent.md — the reasoning + tool calls. Mine it for self-model lessons. |
| \`readPreviously(sliceId)\` | Read a past slice's card snapshot. Check how long a fact has been held. |
| \`finish(reasoning, summary)\` | REQUIRED, LAST call — ends the pass. \`summary\` is ONE sentence IN THE USER'S LANGUAGE describing what changed (shown to the user + the core agent); empty when nothing changed. Call it even when nothing changed. |

## What to do — fold in the NEW evidence only

Compare the conversation in the task against the current card. Incorporate anything NEW and durable; resolve or remove what is stale. **Preserve what is still accurate and well-formed** — do not re-derive content from history, do not rewrite what already reads well.

- New stable fact about the user → fold it into the Past profile paragraph (or Identity head if it is a name/address fact).
- A durable fact that will ALMOST CERTAINLY still be true in 3 years (a date, a decision, a red line) → a Past anchor. Evolving situations do NOT belong in anchors.
- Current situation that will fade → a Now hook (ONE event per line; the details stay in the slices).
- A commitment, deadline, or awaited reply → a Horizon line with \`by\` + refs.
- **Horizon resolution rule**: when the user reports the outcome of an open loop, RESOLVE it — and record the outcome via addNow (or the Past profile if durable). Overdue items are KEPT, never silently dropped.
- A user correction / explicit preference → update the Past paragraph and/or Self-model to reflect it.
- Fragmented or non-English card content → rewrite those entries cleanly (ONE flowing English Past paragraph, every entry in English) while preserving substance.
- Nothing new AND the card is already clean → make no writes; just \`finish\` with a short reasoning.

## Evolution direction and playbooks

You are Phase 2 (product) of a two-phase evolution loop. Phase 1 (a colleague) owns direction.md — the cross-slice statement of what "better for the user" means. When the task includes the current direction, treat it as the CRITERIA you evolve under: the card is the RESULT, the direction is the standard it is judged against. You never edit the direction itself.

You also maintain your colleagues' PLAYBOOKS — short working notes injected into the recall / search / thinkdeep sub-agents' prompts (e.g. "on emotional topics, read the full slice before concluding"). A playbook write is a MUTATION with a hard gate: \`writePlaybook\` is accepted ONLY for a colleague whose bucket the task says triggered this run, and every write must carry its evidence (slice pointers / user quotes) and its expected benefit. A playbook is short guidance, not an archive — rewrite it in place, cap applies.

Scores are sensors, not judges: a triggered bucket means RE-READ the original evidence (the fitness events in the task quote the user's own words; readSlice the slices they point to) and then decide for yourself what — if anything — to change. A trigger never obliges a mutation.

## Identity head — stable, minimal

The Identity head is machine-parsed, so keep it minimal and STABLE:
- **Never change the user's Name, how to address them, or their pronouns unless the user explicitly asks.** A name change is a user correction — you do not infer it. If the card already has a Name, preserve it exactly.
- **Spelling and casing variants are NOT alternate names.** Never add "(also written …)" / "又称 …" annotations inside any Identity field — those corrupt the machine-parsed value.
- A genuine alias/nickname (a name the user actually goes by, distinct from their name) goes in \`setIdentity("alias", …)\`.

## Self-model — DELTA from the standing rules, backed by BOTH timelines

You operate under these standing rules:

${STANDING_RULES.map((r) => `- ${r}`).join("\n")}

Self-model entries must be a **delta** from them — either:
1. A NEW heuristic the rules do not cover (tool usage, answer form, error patterns), or
2. An explicit USER override of a rule — then mark \`overrides: <rule>\` and cite the user's own words.

Evidence bar — reasoning proposes, outcomes dispose:
- **User corrections** (in the conversation) are the strongest source — record them.
- **Error→fix sequences** in the agent timeline (a tool call failed, a retry with a different approach worked) are lessons when the fix GENERALIZES. One-off glitches are not lessons.
- Check your existing Self-model lines BEFORE adding: a lesson already on the card means the pattern RECURRED — prefer sharpening the existing line over adding a near-duplicate. Never restate a standing rule.

When the signal is slice_closed, read the closed slice's agent timeline (\`readAgentTimeline\`) — how the agent thought and called tools there is your raw material for these lessons. User FACTS always come from the conversation (core), never from the agent's narration of it.

## Ref entry format

Every claim carries refs to its evidence slice — cite the slice id exactly as shown: \`["2026-08-07-0709"]\` (slice) or \`["2026-08-07-0709-abc123"]\` (slice-turn). Never invent refs — no evidence, no write.

## Reformat (legacy only)

FIRST check the current card's structure in the task. If it is NOT the v5 card (old stamps, \`## Profile\` / \`## Recent\` / \`## User profile\` / \`### Identity & background\` headers), your working copy starts EMPTY or partially mapped — REBUILD the card through mutations: setIdentity / updatePastProfile / addNow / … carrying over everything still accurate. This wholesale migration is the one case where you re-write existing content.

## Your Process

1. Read the time context + compare the conversation against the card. New durable info? Stale lines? A self-model lesson (user correction / error→fix pattern)?
2. slice_closed and you suspect process lessons → \`readAgentTimeline\` on the closed slice. Verify quotes with \`readSlice\` when unsure.
3. Apply mutations — one tool call per entry change.
4. \`finish\` LAST — 1-3 sentences of reasoning (developer log) + a one-sentence user-language summary of what changed (shown in the UI; empty when nothing changed). Never write after finish.

**Semantic merging:** the same concept across languages (e.g. "self-evolution" and "自我进化") is ONE fact — merge, never duplicate.`;

/** Fully static system prompt — one shared prefix-cache entry across calls. */
const PREVIOUSLY_SYSTEM = buildSubAgentSystem(PREVIOUSLY_ROLE);

function buildTimeContext(input: PreviouslyAgentInput): string {
  const doc = input.previouslyContent.trim()
    ? parseCard(input.previouslyContent)
    : null;
  const today =
    input.todayLocal ??
    doc?.now.find((r) => r.since)?.since ??
    new Date().toISOString().slice(0, 10);
  const lines: string[] = [`**Today (the user's LOCAL date): ${today}**`];
  if (doc) {
    const aged = doc.now
      .map((r) => ({ text: r.text, since: r.since, days: daysBetween(r.since, today) }))
      .filter((r) => r.days >= CARD_NOW_EXPIRY_DAYS);
    if (aged.length > 0) {
      lines.push(
        `Now items PAST the ${CARD_NOW_EXPIRY_DAYS}-day horizon (you decide: promote durable substance to Past, or remove the hook):`,
      );
      for (const r of aged) lines.push(`- ${r.days} days old (since ${r.since}): "${r.text.slice(0, 80)}"`);
    }
    const overdue = findOverdueHorizonItems(doc, today);
    if (overdue.length > 0) {
      lines.push("OVERDUE Horizon items (by already passed — KEEP them, resolve only on fulfillment; flag in text if useful):");
      for (const h of overdue) lines.push(`- by ${h.by}: "${h.text.slice(0, 80)}"`);
    }
  }
  return lines.join("\n");
}

function daysBetween(since: string, today: string): number {
  const a = Date.parse(`${since}T00:00:00.000Z`);
  const b = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/** The dynamic USER prompt: time context, signal, current card, conversation. */
function buildUserPrompt(input: PreviouslyAgentInput): string {
  const {
    signal, note, currentSliceId, closedSliceId, previouslyContent,
    recentTurns, currentSliceTags,
  } = input;

  const signalLabels: Record<PreviouslySignal, string> = {
    new_observation: "new_observation — a new round of conversation happened; check for new information",
    slice_closed: "slice_closed — a time slice just closed; review the whole conversation",
    self_reflection: "self_reflection — the core agent thinks its strategy needs adjustment",
  };

  const deepNote = closedSliceId
    ? `\n**DEEP MODE**: slice \`${closedSliceId}\` just closed. Its full conversation is below; its agent timeline (readAgentTimeline) is your source for self-model lessons.`
    : "";

  const tagsNote = currentSliceTags && currentSliceTags.length > 0
    ? `\n**Current slice tags**: ${currentSliceTags.join(", ")}`
    : "";

  // Two-phase evolution (v1.0 §2.3): the direction is the CRITERIA this pass
  // evolves under; the fitness section is present only when specific buckets
  // triggered (and gates writePlaybook — an untriggered write is rejected).
  const directionSection = input.direction?.trim()
    ? `

## Evolution direction (the criteria — the card is the result)

${input.direction.trim()}`
    : "";

  const triggered = input.triggeredBuckets ?? [];
  const fitnessSection =
    triggered.length > 0
      ? `

## Fitness triggers (why this run happened — scores are sensors, not judges)

Triggered buckets: ${triggered.join(", ")}
${
  (input.fitnessEvents ?? []).length > 0
    ? `\nRecent evidence for the triggered buckets (the user's own words — re-read the slices they point to before deciding):\n${(input.fitnessEvents ?? [])
        .map(
          (e) =>
            `- [${e.ts}] slice ${e.sliceId} · ${e.bucket} ${e.delta > 0 ? `+${e.delta}` : e.delta} — "${e.evidence}"`,
        )
        .join("\n")}`
    : ""
}${
  (input.fitnessSignals ?? []).length > 0
    ? `\nMechanical signals this slice:\n${(input.fitnessSignals ?? [])
        .map((s) => `- ${s.type} — ${s.detail}`)
        .join("\n")}`
    : ""
}

A triggered bucket authorizes (never obliges) a \`writePlaybook\` for the matching colleague (${["recall", "search", "thinkdeep"].filter((b) => triggered.includes(b as FitnessBucket)).join(", ") || "none of the playbook colleagues triggered — writePlaybook will REJECT every call"}).`
      : "";

  return `## Time context

${buildTimeContext(input)}

## Signal

${signalLabels[signal]}
Note: "${note}"${tagsNote}
Current slice: \`${currentSliceId}\`${deepNote}${directionSection}${fitnessSection}

## Current card (your working copy starts from this)

${previouslyContent || "(empty — new card. Build it from the structure in your instructions.)"}

## Recent Conversation (your window into what changed)

${recentTurns.length > 0
  ? recentTurns.map((t) => `**${t.role}**: ${t.content}`).join("\n\n")
  : "(No recent conversation provided.)"}`;
}

// ─── Tools ────────────────────────────────────────────────────────────────

function buildTools(
  input: PreviouslyAgentInput,
  session: CardSession,
  playbookWrites: PlaybookWrite[],
) {
  return {
    // ── Write tools (mutations on the session's working document) ──
    setIdentity: tool({
      description:
        "Set or replace one Identity head field. Name/pronouns/address-as are STABLE — " +
        "change them only when the user explicitly asked.",
      inputSchema: z.object({
        field: z.enum(["name", "address_as", "pronouns", "alias"]),
        value: z.string().describe("The field value, e.g. 'Alan'. Single line."),
      }),
      execute: async ({ field, value }) => sessionSetIdentity(session, field, value),
    }),
    updatePastProfile: tool({
      description:
        `Rewrite the rolling Past profile paragraph IN PLACE (≤ ${CARD_PROFILE_MAX_CHARS} chars). ` +
        "Preserve what is still accurate; fold in new durable substance.",
      inputSchema: z.object({
        text: z.string().describe("The full new profile paragraph, English."),
      }),
      execute: async ({ text }) => sessionUpdatePastProfile(session, text),
    }),
    addPastAnchor: tool({
      description:
        `Add a durable Past anchor fact (≤ ${PAST_ANCHOR_MAX_CHARS} chars, refs required, ≤ ${PAST_ANCHORS_MAX} total). ` +
        "Admission test: almost certainly still true in 3 years.",
      inputSchema: z.object({
        text: z.string(),
        refs: z.array(z.string()).describe("Evidence slice ids, e.g. [\"2026-08-07-0709\"]."),
      }),
      execute: async ({ text, refs }) => sessionAddPastAnchor(session, text, refs),
    }),
    removePastAnchor: tool({
      description: "Remove a Past anchor by a substring of its text.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionRemovePastAnchor(session, match),
    }),
    addNow: tool({
      description:
        `Add a Now hook — a current situation that will fade (≤ ${NOW_ITEM_MAX_CHARS} chars, refs required, ≤ ${CARD_NOW_MAX} total). ` +
        "ONE event per line; the details stay in the slices.",
      inputSchema: z.object({
        text: z.string(),
        refs: z.array(z.string()),
        since: z.string().optional().describe("YYYY-MM-DD, defaults to the user's local today."),
      }),
      execute: async ({ text, refs, since }) => sessionAddNow(session, text, refs, since),
    }),
    removeNow: tool({
      description: "Remove a Now item by a substring of its text.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionRemoveNow(session, match),
    }),
    promoteNowToPast: tool({
      description:
        "Promote a Now item to a durable Past anchor, keeping its refs. " +
        "Use when a fading situation turned out to be lasting.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionPromoteNowToPast(session, match),
    }),
    addHorizon: tool({
      description:
        `Add a Horizon open loop — commitment / deadline / awaited reply ` +
        `(≤ ${HORIZON_ITEM_MAX_CHARS} chars, explicit by date + refs required, ≤ ${HORIZON_MAX} total).`,
      inputSchema: z.object({
        text: z.string(),
        by: z.string().describe("YYYY-MM-DD — when this is due."),
        refs: z.array(z.string()),
      }),
      execute: async ({ text, by, refs }) => sessionAddHorizon(session, text, by, refs),
    }),
    resolveHorizon: tool({
      description:
        "Resolve (remove) a Horizon item — the ONLY way one leaves the card. " +
        "Record the outcome via addNow / updatePastProfile when it matters.",
      inputSchema: z.object({
        match: z.string(),
        note: z.string().optional().describe("Where the outcome went, e.g. 'folded into Now'."),
      }),
      execute: async ({ match, note }) => sessionResolveHorizon(session, match, note),
    }),
    addSelfModel: tool({
      description:
        `Add a Self-model operating lesson (≤ ${SELF_MODEL_LINE_MAX_CHARS} chars, ≤ ${CARD_SELF_MODEL_MAX} total). ` +
        "Must be a DELTA from the standing rules, with process + outcome evidence. " +
        "Check the existing lines first — a recurring lesson sharpens the old line, never duplicates.",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => sessionAddSelfModel(session, text),
    }),
    removeSelfModel: tool({
      description: "Remove a Self-model line by a substring of its text.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionRemoveSelfModel(session, match),
    }),
    // ── Playbook mutation (v1.0 §2.4 — the evolution agent is the single
    // writer of card / direction / playbooks; the write lands on an in-memory
    // list here and is persisted by the caller with its archive record) ──
    writePlaybook: tool({
      description:
        "Rewrite a sub-agent colleague's playbook (short working notes injected into its " +
        "prompt) — agent ∈ recall / search / thinkdeep. HARD GATE: accepted ONLY when that " +
        "colleague's bucket triggered this run (the task lists them); otherwise REJECTED. " +
        "Carry the evidence (slice pointers / user quotes) and the expected benefit — a " +
        "mutation without them is not archivable.",
      inputSchema: z.object({
        agent: z.enum(["recall", "search", "thinkdeep"]),
        content: z
          .string()
          .describe("The FULL new playbook — short behavioral guidance, rewritten in place."),
        evidence: z
          .array(z.string())
          .describe("Slice pointers / verbatim user quotes backing this change."),
        expectedBenefit: z
          .string()
          .describe("One line: what improves if this playbook holds."),
      }),
      execute: async ({ agent, content, evidence, expectedBenefit }) => {
        // Code-level gate: no bucket trigger → no playbook write, with the
        // reason spelled out (the model sees this and moves on).
        const triggered = input.triggeredBuckets ?? [];
        if (!triggered.includes(agent)) {
          return (
            `REJECTED — the "${agent}" bucket did NOT trigger this run ` +
            `(triggered: ${triggered.join(", ") || "none"}). Playbook writes need a ` +
            "fitness trigger; leave the playbook as it is."
          );
        }
        if (!content.trim()) {
          return "REJECTED — playbook content is empty.";
        }
        const capped = capPlaybook(content.trim());
        // One write per agent per pass: a rewrite replaces this pass's earlier
        // draft (the playbook is a whole-document overwrite anyway).
        const existingIdx = playbookWrites.findIndex((w) => w.agent === agent);
        const write: PlaybookWrite = {
          agent,
          content: capped,
          evidence: evidence.filter((e) => e.trim().length > 0),
          expectedBenefit: expectedBenefit.trim(),
        };
        if (existingIdx >= 0) playbookWrites.splice(existingIdx, 1, write);
        else playbookWrites.push(write);
        return (
          `OK — ${agent} playbook staged (${capped.length} chars` +
          (capped.length < content.trim().length ? ", truncated to the cap" : "") +
          "). It is applied when this pass ends."
        );
      },
    }),
    // ── Read tools ──────────────────────────────────────────────────
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
        "Read agent.md for a specific slice — the agent's reasoning and tool calls. " +
        "Mine it for self-model lessons: error→fix sequences, discarded options, strategy choices. " +
        "Never take user FACTS from here — facts come from the conversation.",
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
    // ── Terminal (the report tool — the runner extracts + validates it) ──
    finish: tool({
      description:
        "REQUIRED — call this LAST to end the pass. `reasoning`: 1-3 sentences for the " +
        "developer log. `summary`: ONE short sentence IN THE USER'S LANGUAGE describing " +
        "what this evolution changed (shown to the user and the core agent) — empty string " +
        "when nothing changed. `expectedBenefit`: one line on what improves for the user — " +
        "archived with the mutation record. Call finish even when nothing changed.",
      inputSchema: z.object({
        reasoning: z.string().describe("1-3 sentences for the developer log."),
        summary: z
          .string()
          .describe(
            "One short sentence in the user's language describing what changed, e.g. " +
            "'记下了你周五的面试安排，把等 HR 回复标记为进行中'. Empty when nothing changed.",
          ),
        expectedBenefit: z
          .string()
          .optional()
          .describe(
            "One line: what improves for the user if this change holds (archived with the " +
            "mutation record, design: every mutation carries its expected benefit).",
          ),
      }),
    }),
  };
}

// ─── Runner call ──────────────────────────────────────────────────────────

const MAX_STEPS = 30;
/** Wall-clock budget per attempt (unified runner: SDK timeout + backstop). */
const TIMEOUT_MS = 90_000;

const finishReportSchema = z.object({
  reasoning: z.string(),
  summary: z.string().catch(""),
  expectedBenefit: z.string().catch("").optional(),
});

interface AttemptOutcome {
  reasoning: string;
  summary: string;
  expectedBenefit?: string;
  failed?: boolean;
  partial?: boolean;
}

async function attemptCall(
  input: PreviouslyAgentInput,
  session: CardSession,
  playbookWrites: PlaybookWrite[],
  temperature: number,
): Promise<AttemptOutcome> {
  const res = await runSubAgent<{ reasoning: string; summary: string; expectedBenefit?: string }>({
    model: input.model,
    system: PREVIOUSLY_SYSTEM,
    prompt: buildUserPrompt(input),
    tools: buildTools(input, session, playbookWrites),
    reportToolName: "finish",
    reportSchema: finishReportSchema,
    maxSteps: MAX_STEPS,
    timeoutMs: TIMEOUT_MS,
    effort: "low",
    temperature,
    onLine: input.onLine,
  });

  if (res.ok && res.report) {
    return {
      reasoning: res.report.reasoning,
      summary: res.report.summary,
      ...(res.report.expectedBenefit?.trim()
        ? { expectedBenefit: res.report.expectedBenefit.trim() }
        : {}),
    };
  }
  if (res.ok) {
    // Step limit reached without finish (or a plain-text stop / unparseable
    // finish call): the mutations that already landed are still valid work —
    // return the card as it stands, flagged partial, instead of failing.
    if (res.text.trim())
      console.warn("[PreviouslyAgent] Agent produced text instead of finish:", res.text.slice(0, 200));
    return { reasoning: "step limit reached without finish", summary: "", partial: true };
  }
  return { reasoning: res.error ?? "Previously Agent failed", summary: "", failed: true };
}

const RETRY_DELAY_MS = 300;

async function attempt(
  input: PreviouslyAgentInput,
  today: string,
  temperature: number,
): Promise<PreviouslyAgentOutput> {
  // A fresh session per attempt — a retried pass never inherits half-applied
  // mutations. The staged playbook writes are likewise per-attempt.
  const session = createCardSession(
    input.previouslyContent,
    input.currentSliceId,
    today,
  );
  const playbookWrites: PlaybookWrite[] = [];
  const r = await attemptCall(input, session, playbookWrites, temperature);
  const failed = r.failed === true;
  return {
    updatedCard: failed ? "" : serializeSession(session),
    reasoning: r.reasoning,
    summary: r.summary,
    mutations: session.log,
    failed: failed || undefined,
    partial: r.partial,
    // Playbook writes stage independently of the card's finish state: a
    // partial pass may still have landed a valid playbook mutation.
    ...(playbookWrites.length > 0 && !failed ? { playbookWrites } : {}),
    ...(r.expectedBenefit ? { expectedBenefit: r.expectedBenefit } : {}),
  };
}

/**
 * Run the Previously Agent. Never throws.
 *   - clean finish          → the serialized card;
 *   - step limit w/o finish → the serialized card flagged `partial` (the
 *     loop brake force-lands repeated length violations, so partial work is
 *     bounded and sane) — the caller writes it back with a partial note;
 *   - hard failure          → ONE retry at temperature 0.4: the higher
 *     temperature breaks the deterministic re-submission loop a cold model
 *     can fall into (the session's loop brake is the in-pass guard). Still
 *     failing → empty card + `failed`, so the caller can no-op gracefully.
 */
export async function runPreviouslyAgent(
  input: PreviouslyAgentInput,
): Promise<PreviouslyAgentOutput> {
  const today = input.todayLocal ?? new Date().toISOString().slice(0, 10);
  const first = await attempt(input, today, 0.1);
  if (!first.failed) return first;
  console.warn(
    "[PreviouslyAgent] First attempt failed, retrying at temperature 0.4:",
    first.reasoning,
  );
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  const second = await attempt(input, today, 0.4);
  if (!second.failed) return second;
  return {
    updatedCard: "",
    reasoning: second.reasoning || "Previously Agent worker unavailable",
    summary: "",
    mutations: [],
    failed: true,
  };
}
