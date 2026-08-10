/**
 * Workflow error classification — the enumerative, keyed-on-error handling for
 * the chat turn's `agent.stream()` boundary.
 *
 * `@ai-sdk/workflow` does NOT import the `@workflow/errors` SDK classes; it only
 * special-cases `AbortError` and bubbles everything else up to the workflow
 * body's catch block. So this module is where the app decides what an error
 * means and what to do:
 *
 *   abort     → client cancelled / SDK abort — end the turn gracefully.
 *   transient → infrastructure blip (5xx, transport, throttle, replay
 *               divergence) — rethrow so the workflow queue redelivers/retries.
 *   timeout   → a step was platform-killed or a deadline exceeded — the main
 *               agent should CONTINUE (续写) with a bounded re-invocation.
 *   model     → provider/model failure (bad key, quota, rate limit, content
 *               filter) — surface a client-visible explanation.
 *   terminal  → run cannot recover (corrupted event log, contract mismatch,
 *               not-registered, expired run) — surface an explanation.
 *
 * Detection is NAME-based (`.is()`-style duck checks), not `instanceof`, because
 * the workflow body runs in a separate VM realm where the SDK error classes are
 * distinct objects. The name set mirrors `@workflow/errors@4.1.4` + the
 * `@workflow/core@4.6.0` `classify-error.js` categories.
 */

export type WorkflowErrorKind =
  | "abort"
  | "transient"
  | "timeout"
  | "model"
  | "terminal";

export interface ClassifiedWorkflowError {
  kind: WorkflowErrorKind;
  /** Technical error message (log-facing). */
  message: string;
  /** Client-visible explanation — present for `model` and `terminal`. */
  userMessage?: string;
}

/** Workflow SDK transient codes (see @workflow/core classify-error.js). */
const RETRYABLE_WORLD_CODES = new Set(["TRANSPORT", "TIMEOUT"]);
/** Workflow SDK terminal contract codes (see @workflow/core classify-error.js). */
const WORLD_CONTRACT_CODES = new Set([
  "PARSE_ERROR",
  "SCHEMA_VALIDATION",
  "WORLD_CONTRACT_ERROR",
]);

const TRANSIENT_RE =
  /(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|UND_ERR_REQ_RETRY|network error|temporary|5\d\d|Throttle)/i;
const TIMEOUT_RE =
  /(timeout|deadline|FUNCTION_INVOCATION|maximum queue deliveries|exceeded max|cut off|interrupted|aborted by platform)/i;
const MODEL_RE =
  /(invalid api key|authentication|unauthorized|insufficient_quota|rate.?limit|content.?filter|permission|400|401|403|404)/i;

/** Shorten a raw message for user display (keep it one line-ish). */
function displayMessage(msg: string, max = 180): string {
  const trimmed = msg.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Classify a workflow-runtime / agent-loop error into an actionable kind.
 * Errors cross the VM realm, so all checks are name/pattern based.
 */
export function classifyWorkflowError(err: unknown): ClassifiedWorkflowError {
  if (err === null || err === undefined) {
    return { kind: "terminal", message: "Unknown workflow error (empty)" };
  }
  const error = err as Error & { name?: unknown; code?: unknown; status?: unknown };
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : String(err);

  // Client cancel / SDK abort — not a failure.
  if (name === "AbortError") return { kind: "abort", message };

  // ── Workflow SDK error classes (name-based) ──────────────────────────────
  if (name === "ThrottleError") {
    return { kind: "transient", message };
  }
  if (name === "WorkflowWorldError") {
    const code = typeof error.code === "string" ? error.code : undefined;
    const status = typeof error.status === "number" ? error.status : undefined;
    if (WORLD_CONTRACT_CODES.has(code ?? "")) {
      return {
        kind: "terminal",
        message,
        userMessage:
          "The workflow infrastructure returned an unexpected response. This is a runtime issue, not something the model did — please retry the conversation.",
      };
    }
    if (RETRYABLE_WORLD_CODES.has(code ?? "") || (status !== undefined && status >= 500)) {
      return { kind: "transient", message };
    }
  }
  if (
    name === "CorruptedEventLogError" ||
    name === "StepNotRegisteredError" ||
    name === "WorkflowNotRegisteredError" ||
    name === "RuntimeDecryptionError"
  ) {
    return {
      kind: "terminal",
      message,
      userMessage:
        "The workflow run cannot be recovered (event log or runtime mismatch). Please retry the conversation.",
    };
  }
  if (name === "ReplayDivergenceError") {
    // The runtime retries replay divergence internally; treat as transient.
    return { kind: "transient", message };
  }
  if (name === "RunExpiredError" || name === "WorkflowRunNotFoundError" || name === "WorkflowRunCancelledError") {
    return {
      kind: "terminal",
      message,
      userMessage: "The workflow run is no longer available. Please send your message again.",
    };
  }

  // ── Model / provider failures — surface to the user ─────────────────────
  if (MODEL_RE.test(message)) {
    return {
      kind: "model",
      message,
      userMessage: `The model call failed: ${displayMessage(message)}`,
    };
  }

  // ── Explicit timeout signals ────────────────────────────────────────────
  if (TIMEOUT_RE.test(message)) {
    return { kind: "timeout", message };
  }

  // ── Transient infrastructure ────────────────────────────────────────────
  if (TRANSIENT_RE.test(message)) {
    return { kind: "transient", message };
  }

  // Default: a step that failed without a clean signature. The dominant cause
  // of agent.stream() throwing is a platform-killed step (no error code — the
  // process is SIGKILL'd, the queue redelivers, and eventually a generic
  // "exceeded retries" surfaces). Classify as timeout so the bounded
  // continuation path handles it; a genuinely terminal error still resolves to
  // `interrupted` after the continuation bound instead of a silent empty turn.
  return { kind: "timeout", message };
}

/** Extract a concise log-facing message from any thrown value. */
export function errorMessage(err: unknown, fallback = "Unknown error"): string {
  if (err === null || err === undefined) return fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "string") return err || fallback;
  try {
    return JSON.stringify(err) || fallback;
  } catch {
    return fallback;
  }
}
