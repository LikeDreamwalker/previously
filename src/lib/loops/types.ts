/**
 * Loop execution records — the "autonomous work" memory layer.
 *
 * A loop is a durable, multi-step task the agent runs on its own (backed by a
 * Vercel Workflow run). Its live execution record is written to
 * `memory/loops/YYYY/MM/DD/<loopId>.md` after every step, so the human — and
 * the agent's own future recall — can see what happened while they were away.
 *
 * Persistence and resumption are owned by the Workflow runtime, not by
 * re-reading a task file across HTTP requests.
 */

export type LoopStatus =
  | "running"
  | "completed"
  | "stuck"
  | "timeout"
  | "failed";

export interface LoopStep {
  /** 1-based index of this step within the loop. */
  step: number;
  /** What the loop decided to do this iteration, in one line. */
  action: string;
  /** The outcome / reasoning the model produced this step. */
  result: string;
  /** ISO 8601 completion time (stamped inside the step, real wall-clock). */
  time: string;
}

/** Serializable input passed by value into the durable workflow. */
export interface LoopInput {
  /** Domain id, also the file stem: memory/loops/.../<loopId>.md */
  loopId: string;
  /** Full whitelisted path the run record is written to. */
  filePath: string;
  /** What the human asked the loop to accomplish. */
  goal: string;
  /** Keyword tags, woven into strands (Phase 2). */
  tags: string[];
  /** Originating time-slice id, for the attachment back-reference (Phase 2). */
  sliceOrigin: string | null;
  /** ISO 8601 start time (stamped in the route, real wall-clock). */
  startedAt: string;
  /** Hard cap on iterations — the structural runaway guard. */
  maxIterations: number;
  /** Resolved worker model for the loop brain (see src/lib/models/worker.ts). */
  workerModel: import("@/lib/models/registry").ModelConfig;
}

/** The full run record, serialized to the loop's markdown file. */
export interface LoopRun {
  loopId: string;
  goal: string;
  status: LoopStatus;
  startedAt: string;
  updatedAt: string;
  sliceOrigin: string | null;
  tags: string[];
  iterations: number;
  maxIterations: number;
  lastError: string;
  steps: LoopStep[];
}

/** Returned by the workflow when the run settles. */
export interface LoopResult {
  loopId: string;
  status: LoopStatus;
  iterations: number;
}
