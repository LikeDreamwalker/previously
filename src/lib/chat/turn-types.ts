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
import type { UserConfig } from "@/lib/config/types";

/**
 * Everything a turn needs, built once in `start-turn.ts` (the only place real
 * `new Date()` / id-minting is allowed) and passed by value into the run. Must
 * stay JSON-serializable end to end.
 */
export interface TurnInput {
  /** Converted chat history for `streamText`. */
  modelMessages: ModelMessage[];
  /** Trimmed recent turns for Flash + context assembly. */
  recentTurns: Array<{ role: string; content: string }>;
  /** The latest user message text, extracted from the raw UI messages. */
  lastUserMessage: string;
  /** Resolved model id (body override → config default). */
  model: string;
  /** Whether DeepSeek thinking is enabled for this turn. */
  thinking: boolean;
  /** Reasoning effort level for this turn. */
  reasoningEffort: "low" | "medium" | "high";
  /** Client-reported timezone, used when minting a new slice. */
  clientTimezone: string;
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

/** Result of the housekeeping step — slice + prepared context for the agent. */
export interface HousekeepingResult {
  slice: TimeSlice;
  /** Content of previously.md for the current slice. */
  previouslyContent: string;
  /** Formatted strands menu string (empty if no strands exist). */
  strandsMenu: string;
}

/** A background loop the agent started during this turn (for slice writeback). */
export interface StartedLoopRef {
  loopId: string;
  tags: string[];
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
  /** Loops started via the startLoop tool during this turn. */
  startedLoops: StartedLoopRef[];
  /**
   * Mechanically extracted cognition data for agent.md — reasoning traces
   * and tool calls with success/failure status. Written by finalizeTurn.
   */
  cognition: string;
}
