/**
 * Thinking-agent (thinkDeep) types — the Layer 3 dispatch primitive.
 *
 * A thinking agent is a focused analyst that works ONE bounded question in the
 * background (its own durable workflow run) and writes a structured report to
 * `memory/thinking/<thinkId>/report.md`. The main agent dispatches several in
 * parallel, waits durably, then integrates their reports into one answer —
 * "multi-agent for exploration, single-agent for writing".
 *
 * Mirrors the loop types (src/lib/loops/types.ts): a serializable input passed
 * by value into the durable workflow, and a report record persisted to disk.
 */

import type { ModelConfig } from "@/lib/models/registry";

export type ThinkStatus = "running" | "completed" | "interrupted";

/** Serializable input passed by value into the thinking-agent workflow. */
export interface ThinkInput {
  /** Domain id, also the directory stem: memory/thinking/<thinkId>/. */
  thinkId: string;
  /** The self-contained question the agent must answer. */
  question: string;
  /** How deeply to think: 'low' for quick analysis, 'high' for thorough. */
  effort: "low" | "high";
  /** Optional shape guidance for the report (e.g. "pros and cons table"). */
  outputFormat?: string;
  /**
   * The byte-identical prefix shared by every agent dispatched in the same
   * turn (identity + previously + strands). Placed first in the prompt so
   * DeepSeek's automatic prefix cache hits for agents 2-N.
   */
  sharedContext: string;
  /** Model config for the thinking agent (the main model, not the worker). */
  model: ModelConfig;
  /** GitHub repo owner (or "local" without a token). */
  owner: string;
  /** GitHub repo name (or "local" without a token). */
  repo: string;
  /** Whether GitHub token is configured. */
  useGithub: boolean;
  /** ISO 8601 start time (stamped in the dispatching step, real wall-clock). */
  startedAt: string;
}

/** The final report, persisted to memory/thinking/<thinkId>/report.md. */
export interface ThinkReport {
  thinkId: string;
  question: string;
  status: ThinkStatus;
  startedAt: string;
  updatedAt: string;
  /** The report body (agent's final text; partial on interruption). */
  content: string;
}

/** Returned by the workflow when the run settles. */
export interface ThinkResult {
  thinkId: string;
  status: ThinkStatus;
}
