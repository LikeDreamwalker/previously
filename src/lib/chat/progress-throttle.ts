/**
 * Throttling for `data-tool-progress` writes (used by thinkDeepExecute).
 *
 * WHY: the server-side delivery of `getWritable()` chunks is a serial pump —
 * the flushablePipe awaits each server write, capping throughput at ~55-60
 * chunks/sec in local dev. thinkDeep writes on every token (~100-200/sec)
 * fire-and-forget, so writes pile up in the pump queue and drain AFTER the
 * turn has rendered (the answer/正文 was observed arriving ~49s late). The
 * client merges progress chunks by (type, id) and keeps only the latest line,
 * so dropping intermediate writes is free.
 */

/**
 * Minimum interval between consecutive `data-tool-progress` writes (ms).
 * ~25 writes/sec — plenty smooth for a single-line typewriter, with ~2x
 * headroom under the pump's measured throughput.
 */
export const PROGRESS_THROTTLE_MS = 40;

/**
 * The tool progress stage ladder: `running` (tool started, spinner) →
 * `thinking` (reasoning in progress, mono muted subtitle) → `writing` (the
 * answer is being composed, brand-tinted subtitle) → `done` (settled, static).
 */
export type ToolProgressStage = "running" | "thinking" | "writing" | "done";

/** Current state of the throttle — what was last emitted. */
export interface ProgressWriteState {
  /** ms timestamp of the last emitted progress chunk (0 = none yet). */
  lastWriteMs: number;
  /** last emitted line text — used to detect line resets (newlines). */
  lastLine: string;
  /** last emitted stage — a change (thinking → writing) forces a send. */
  lastStage: ToolProgressStage | undefined;
  /** whether any progress chunk has been emitted yet. */
  sentAny: boolean;
}

/** The line currently being considered for emission. */
export interface ProgressLine {
  /** The current single line (text after the last newline). */
  line: string;
  /** "thinking" while reasoning, "writing" once the answer has begun. */
  stage: ToolProgressStage;
}

/**
 * Decides whether a progress line should be emitted now. A write is allowed
 * when: nothing has been sent yet (first line arrives immediately), the stage
 * changed (the thinking → answer color transition must not be delayed), the
 * line reset (a newline started a shorter line — the visual "re-render from
 * scratch"), or enough time has elapsed since the last write. Otherwise it is
 * dropped; the client replaces the merged part's data, so the latest line
 * always wins.
 */
export function shouldEmitProgress(
  state: ProgressWriteState,
  line: ProgressLine,
  now: number,
  throttleMs: number = PROGRESS_THROTTLE_MS,
): boolean {
  if (!state.sentAny) return true;
  if (state.lastStage !== line.stage) return true;
  if (line.line.length < state.lastLine.length) return true;
  return now - state.lastWriteMs >= throttleMs;
}
