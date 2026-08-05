/**
 * Per-step soft timeout — wraps a `"use step"` executor's work with a
 * `Promise.race`-based timer.
 *
 * Unlike the AI SDK's `timeout` option (which calls `AbortSignal.timeout()`),
 * this needs no AbortSignal global — the workflow sandbox doesn't provision it,
 * and the step runtime is real Node where `setTimeout` works. A timeout does
 * NOT abort the underlying work (the race loser keeps running to completion in
 * the background); it only stops the step from blocking past its budget. The
 * caller decides how to surface the partial result, typically by capturing
 * text in `onTimeout`.
 *
 * Used by the long-running tool executors (thinkDeep 240s, recall 120s,
 * webSearch 60s) as a soft safety net on top of the per-provider token budget.
 */
export class StepTimeoutError extends Error {
  constructor() {
    super("Step timed out");
    this.name = "StepTimeoutError";
  }
}

export interface StepTimeoutResult<T> {
  ok: boolean;
  timedOut: boolean;
  /** The work's value when it settled before the deadline. */
  result?: T;
  /** Any partial output captured by `onTimeout` when the deadline hit. */
  partialText?: string;
  /** Wall-clock time the step actually waited, in milliseconds. */
  elapsedMs: number;
}

/**
 * Run `work` with a soft deadline of `timeoutMs`. Returns a structured result:
 * `{ ok: true, result }` when work wins the race, `{ ok: false, timedOut: true,
 * partialText }` when the timer wins. Non-timeout errors from `work` re-throw —
 * they are genuine failures that should surface as step retries, not timeouts.
 *
 * The timer is always cleared once the race settles, so a fast success leaves
 * no dangling timeout keeping the process alive.
 */
export async function withStepTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => string | undefined,
): Promise<StepTimeoutResult<T>> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError()), timeoutMs);
  });

  try {
    const result = await Promise.race([work(), timeoutPromise]);
    return { ok: true, timedOut: false, result, elapsedMs: Date.now() - start };
  } catch (err) {
    if (err instanceof StepTimeoutError) {
      return {
        ok: false,
        timedOut: true,
        partialText: onTimeout?.(),
        elapsedMs: Date.now() - start,
      };
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
