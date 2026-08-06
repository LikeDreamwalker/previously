/**
 * Tool-error triage — deterministic tool failures become model-readable tool
 * results, NOT thrown exceptions.
 *
 * The WorkflowAgent runs each tool call as a durable, auto-retried step. A
 * thrown error triggers workflow retries on a failing step. That is correct
 * for genuinely transient failures (a flaky network read, a 5xx) but wrong —
 * and expensive — for deterministic ones (a missing config, an unparseable
 * model output, a file that never existed): retrying can never succeed, and a
 * step stuck retrying blocks the whole turn.
 *
 * Triage rule: return deterministic failures as DATA with a semantic message
 * the model can act on ("this tool is unavailable because…"); re-throw only
 * transient errors that a retry could actually fix.
 */
import { InvalidToolInputError } from "ai";

/** A re-throwable set of transient network-ish failure patterns. */
const TRANSIENT_MESSAGE_RE =
  /(ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timeout|temporary|429|5\d\d)/i;

/**
 * Decide whether a thrown error is worth a workflow retry. Everything
 * deterministic (validation, config, domain) returns false.
 */
export function isTransientError(err: unknown): boolean {
  if (InvalidToolInputError.isInstance(err)) return false;
  return err instanceof Error && TRANSIENT_MESSAGE_RE.test(err.message);
}

/**
 * Convert an error into a short, model-facing explanation of why this tool
 * failed and whether the failure is permanent. Deterministic failures get a
 * clear "cannot be retried" note so the model does not loop on them.
 */
export function triageErrorMessage(
  err: unknown,
  toolName: string,
  fallback = "The tool failed unexpectedly.",
): string {
  const msg = err instanceof Error ? err.message : String(err);
  const transient = isTransientError(err);
  return (
    `[${toolName} unavailable] ${msg}. ` +
    (transient
      ? "This looks transient — you may retry once."
      : "This is a deterministic failure — retrying will not help; try a different approach.")
  );
}
