/**
 * Rework-signal instrumentation (v1.0 design §2.6).
 *
 * The most valuable implicit fitness signal: the main agent calls `recall`,
 * then opens slices ITSELF with readSlice. readSlice stays in the chat tool
 * surface as the VERIFICATION channel (design §1.4), so not every post-recall
 * read is a penalty:
 *
 *   - "verify" — the read slice was among recall's references (the by-design
 *     audit path), or within the set recall searched (the main agent pulling
 *     more original text from a slice recall already surfaced — recall.ts's
 *     contract explicitly allows this).
 *   - "rework" — a recall ran this conversation and the read slice was NOT in
 *     its references or searched trail: the main agent is doing recall's job
 *     itself, i.e. recall's answer was not trusted/used.
 *   - null — no recall has run this conversation (nothing to compare against),
 *     or the read target IS the ongoing conversation slice.
 *
 * The per-conversation record is module-level per-process state — the same
 * pattern manager.ts already uses for the active slice. Workflow steps in one
 * process share the module, so the recall outcome recorded by recallExecute is
 * visible to a later readSliceExecute. The map is FIFO-bounded: conversations
 * are short-lived and an unbounded map would leak across the process lifetime.
 *
 * Every emitted signal lands in TWO places, both best-effort (failures are
 * swallowed with a console.warn — instrumentation must never fail a tool):
 *   1. the fitness store (machine-readable, for the analyzer stage), and
 *   2. one compact structured line in the CURRENT slice's agent.md
 *      (human/audit-readable), via manager.ts's writeAgentTimeline.
 */

import { appendSignal } from "@/lib/evolution/store";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import { writeAgentTimeline } from "./manager";

/** What recall found, kept per conversation slice for later readSlice checks. */
export interface RecallOutcome {
  /** Slice ids of recall's evidence references (the verification set). */
  referenceIds: string[];
  /** Recall's searched trail — free-text entries; a slice id may appear
   *  embedded (e.g. "slice 2026-07-24-1500"), so membership is a substring
   *  check, not equality. */
  searchedIds: string[];
  confidence: number;
}

export type ReworkKind = "verify" | "rework";

/** Max conversations tracked per process — FIFO eviction beyond this. */
const MAX_TRACKED_CONVERSATIONS = 50;

/** conversation slice id → latest recall outcome. Insertion order = recency
 *  (recordRecallOutcome re-inserts on update), so eviction drops the stalest. */
const outcomes = new Map<string, RecallOutcome>();

/**
 * Record the outcome of a successful recall run. Later readSlice calls in the
 * same conversation are classified against THIS record (the latest recall
 * wins — a second recall supersedes the first as the reference point).
 */
export function recordRecallOutcome(
  conversationSliceId: string,
  outcome: RecallOutcome,
): void {
  if (!conversationSliceId) return;
  outcomes.delete(conversationSliceId);
  outcomes.set(conversationSliceId, outcome);
  while (outcomes.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = outcomes.keys().next().value;
    if (oldest === undefined) break;
    outcomes.delete(oldest);
  }
}

/**
 * Classify a main-agent readSlice against this conversation's last recall
 * outcome. Pure read of the module record — the side-effecting counterpart is
 * logReworkSignal.
 */
export function checkReadSlice(
  conversationSliceId: string,
  readSliceId: string,
): ReworkKind | null {
  const outcome = outcomes.get(conversationSliceId);
  if (!outcome) return null;
  // Reading the ONGOING conversation slice is never recall verification —
  // recall excludes it from references by contract, so it would always
  // misclassify as rework.
  if (readSliceId === conversationSliceId) return null;
  if (outcome.referenceIds.includes(readSliceId)) return "verify";
  // Within recall's searched trail (but not cited): the main agent is pulling
  // more of an original text recall already surfaced — still the by-design
  // verification channel, not independent re-search.
  if (outcome.searchedIds.some((s) => s.includes(readSliceId))) return "verify";
  return "rework";
}

/**
 * Emit the signal for a classified readSlice: the machine-readable fitness
 * store entry plus one compact audit line in the current slice's agent.md.
 * BOTH writes are best-effort — each failure is warned and swallowed; this
 * function never throws and never fails the calling tool.
 */
export async function logReworkSignal(
  conversationSliceId: string,
  readSliceId: string,
  kind: ReworkKind,
): Promise<void> {
  const ts = new Date().toISOString();
  const type = kind === "verify" ? "recall_verify" : "recall_rework";
  const detail =
    kind === "verify"
      ? `main agent read slice ${readSliceId} within recall's references/searched — by-design verification`
      : `main agent read slice ${readSliceId} outside recall's references/searched — doing recall's job itself`;

  try {
    await appendSignal({ ts, sliceId: conversationSliceId, type, detail });
  } catch (e) {
    console.warn(
      "[ReworkSignal] fitness-store write failed:",
      e instanceof Error ? e.message : e,
    );
  }

  try {
    await writeAgentTimeline(
      conversationSliceId,
      `- **${type}** ${ts} — ${detail}.`,
    );
  } catch (e) {
    console.warn(
      "[ReworkSignal] agent.md append failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Interaction-signal types — the user's own hands on the UI (design §2.6
 *  extended): regenerate = the previous reply was rejected; interrupt = the
 *  reply was cut off mid-stream. Both are dissatisfaction candidates for the
 *  interaction bucket; the analyzer decides, these only record the fact. */
export type InteractionSignalType =
  | "interaction_regenerate"
  | "interaction_interrupt";

/**
 * Emit an interaction signal (regenerate / interrupt): the machine-readable
 * fitness store entry plus one compact audit line in the slice's agent.md.
 * Same double-write, never-throws discipline as logReworkSignal.
 */
export async function logInteractionSignal(
  type: InteractionSignalType,
  sliceId: string,
  detail: string,
  batch?: WriteBatch,
): Promise<void> {
  if (!sliceId) return;
  const ts = new Date().toISOString();

  try {
    await appendSignal({ ts, sliceId, type, detail }, batch);
  } catch (e) {
    console.warn(
      "[InteractionSignal] fitness-store write failed:",
      e instanceof Error ? e.message : e,
    );
  }

  try {
    await writeAgentTimeline(sliceId, `- **${type}** ${ts} — ${detail}.`);
  } catch (e) {
    console.warn(
      "[InteractionSignal] agent.md append failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
