/**
 * By-value contract for the durable chat turn.
 *
 * Every chat turn runs inside a Vercel Workflow run (see
 * `src/app/api/chat/turn-workflow.ts`). The workflow body is deterministic and
 * runs its steps in *separate invocations*, so nothing can be shared through a
 * module-global (the old `activeSlice` in episodic/manager.ts is unusable
 * there). All state the steps need is threaded through these serializable
 * shapes: `TurnInput` in, the slice + Flash output re-bound after each mutating
 * step.
 *
 * TYPE-ONLY MODULE. Everything here is erased at compile time, so importing it
 * from the `"use workflow"` file pulls no Node.js code into the workflow bundle.
 */
import type { ModelMessage } from "ai";
import type { TimeSlice } from "@/lib/episodic";
import type { CardChangeSummary, CardMutation } from "@/lib/episodic/card-diff";
import type { UserConfig } from "@/lib/config/types";
import type { ModelConfig } from "@/lib/models/registry";

/**
 * Everything a turn needs, built once in `start-turn.ts` (the only place real
 * `new Date()` / id-minting is allowed) and passed by value into the run. Must
 * stay JSON-serializable end to end.
 */
export interface TurnInput {
  /**
   * Converted chat history from the client (capped at a broad payload limit
   * in start-turn). The workflow cuts the slice-aligned window from its tail
   * before streaming (sliceAlignedWindow in turn-workflow.ts) — the client
   * remains the history source, the slice decides what the model sees.
   */
  modelMessages: ModelMessage[];
  /** Trimmed recent turns for Flash + context assembly. */
  recentTurns: Array<{ role: string; content: string }>;
  /** The latest user message text, extracted from the raw UI messages. */
  lastUserMessage: string;
  /** Resolved model id (body override → config default). */
  model: string;
  /**
   * The full resolved model config — carries sdk/baseURL/envKey so the agent
   * can construct the right provider model for models.dev-derived ids (which
   * are not in the curated registry). Resolved in start-turn.
   */
  modelConfig: ModelConfig;
  /** Whether DeepSeek thinking is enabled for this turn. */
  thinking: boolean;
  /** Reasoning effort level for this turn. */
  reasoningEffort: "low" | "medium" | "high";
  /** Client-reported timezone, used when minting a new slice. */
  clientTimezone: string;
  /**
   * UI locale ("zh" | "en") — relative-time annotations in the injected card,
   * turn brief, timeline brief, and read-tool output follow it. Normalized in
   * start-turn with fallback "en".
   */
  locale: string;
  /** User config snapshot (loaded once in the route layer). */
  config: UserConfig;
  /** GitHub repo owner (or "local" without a token). */
  owner: string;
  /** GitHub repo name (or "local" without a token). */
  repo: string;
  /** Whether GitHub token is configured (resolved in start-turn). */
  useGithub: boolean;
  /** Whether demo mode is active (resolved in start-turn). */
  useDemo: boolean;
  /** ISO 8601 turn start, stamped in the route layer. */
  startedAtIso: string;
  /**
   * Unique turn identifier — one per round of conversation (user message +
   * agent response + agent cognitive process). 6-char base64url, generated in
   * start-turn.ts. Cross-references core.md and agent.md.
   */
  turnId: string;
}

/** Summary of a synchronous card evolution run (v0.7b — inline in housekeeping). */
export interface EvolutionResult {
  ran: boolean;
  changed: boolean;
  droppedRecent: number;
  note: string;
  /** ONE user-language sentence describing what changed — the indicator's
   *  headline and the core agent's account of the evolution. */
  summary?: string;
  /** Line-level mutations vs the previous card — the indicator's expanded diff. */
  mutations?: CardMutation[];
  /** Semantic change counts — the indicator's collapsed summary chips. */
  changes?: CardChangeSummary;
  /** Set when the evolution FAILED (worker down, write error) — a failure must
   *  never be presented as a legitimate "no changes" result. */
  error?: string;
  /** Set when the pass ended without a finish call (step cap / timeout) — the
   *  card carries whatever mutations landed before the cutoff. */
  partial?: boolean;
}

/** Result of the housekeeping step — slice + prepared context for the agent. */
export interface HousekeepingResult {
  slice: TimeSlice;
  /** Content of previously.md for the current slice. */
  previouslyContent: string;
  /** Formatted strands menu string (empty if no strands exist). */
  strandsMenu: string;
  /**
   * The frozen slice-head snapshot block (L3): slice-start local time, date
   * anchors, continuity stance at slice birth, and the birth-evolution
   * summary. Every input anchors to `slice.start`, so the block is
   * byte-identical on every turn of the slice (v0.9 prefix-cache freeze).
   * See buildSliceHeadBlock in src/lib/turn-priming.ts.
   */
  sliceHeadBlock: string;
  /**
   * The agent's constitution: SOUL + "who you're assisting" + DIRECTIVES
   * (memory access rules included), derived from previously.md's identity
   * section. Injected into the system prompt. See src/lib/identity.
   */
  identityPrompt: string;
  /**
   * v0.8 — compact timeline brief (recent slice pointer lines + catalog
   * totals), assembled from the woven index. Injected into the system prompt
   * so the agent can perceive the recent past without reading slices. Since
   * v0.9 it is built in frozen mode (absolute dates, only slices closed
   * before the current one) so it stays byte-stable within the slice. Absent
   * when the timeline isn't available yet.
   */
  timelineBrief?: string;
}

/**
 * What the workflow extracts (as pure serializable values) from the agent
 * stream result and hands to the finalizeTurn step.
 */
export interface TurnOutcome {
  /** Final assistant text (empty when the model produced none). */
  text: string;
  /** Finish reason of the last step — "stop" means a clean completion. */
  finishReason: string;
  /**
   * Mechanically extracted cognition data for agent.md — reasoning traces
   * and tool calls with success/failure status. Written by finalizeTurn.
   */
  cognition: string;
  /**
   * Client-visible explanation for a non-stop finish (workflow timeout /
   * terminal model error). Emitted in the terminal `data-turn-status` chunk so
   * the client can show why the turn ended instead of failing silently.
   * Absent for clean "stop" turns and for the partial-text "interrupted" case.
   */
  error?: string;
}

// ─── Turn status / persistent turn state (Layer 2, v0.6) ───────────────────

/**
 * Turn-level lifecycle status, streamed to the client as `data-turn-status`
 * chunks. No persistence layer — the agent's reply is already in the time
 * slice; the client sees these chunks live or reconnects via the stored runId.
 *
 * Terminal-only lifecycle statuses. Mid-turn transitions (thinking /
 * synthesizing around dispatched sub-agents) were removed when thinkDeep
 * became an agent-as-a-tool: reasoning fragments now flow back inline through
 * tool results, so there is no separate wait/integrate phase to announce.
 */
export type TurnStatus =
  | "active" // LLM is generating or tools are executing
  | "done" // Final text delivered to client
  | "interrupted" // Timeout or error, partial result available
  | "error"; // Fatal error, no result

/**
 * Derive the terminal turn status from the agent's finish reason and output.
 * Pure function — used by finalizeTurn to emit the terminal data-turn-status
 * stream chunk. The client sees it live or reconnects via the stored runId.
 */
export function deriveTurnStatus(outcome: TurnOutcome): TurnStatus {
  if (outcome.finishReason === "stop") return "done";
  // An explicit soft-timeout interruption is always "interrupted", even when
  // the model produced no text before it was cut off (the client offers a
  // "continue" path rather than treating it as a hard error).
  if (outcome.finishReason === "interrupted") return "interrupted";
  if (outcome.text) return "interrupted";
  return "error";
}
