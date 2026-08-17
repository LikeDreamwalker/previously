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
 * Detection prefers STRUCTURED evidence (`.statusCode`, error names) over
 * message regexes, and every check is duck-typed, never `instanceof`, because
 * the workflow body runs in a separate VM realm where the SDK error classes
 * are distinct objects. The name set mirrors `@workflow/errors@4.1.4` + the
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
// Message-regex LAST RESORT for model failures. NOTE: no bare `400`/`404` —
// a GitHub-404 or a bad-request body from a tool's fetch is not a model
// failure; structured statusCode evidence (below) decides those.
const MODEL_RE =
  /(invalid api key|authentication|unauthorized|insufficient_quota|rate.?limit|content.?filter|permission denied|\b401\b|\b403\b)/i;

/** Shorten a raw message for user display (keep it one line-ish). */
function displayMessage(msg: string, max = 180): string {
  const trimmed = msg.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Classify a workflow-runtime / agent-loop error into an actionable kind.
 * Errors cross the VM realm, so all checks are name/pattern based.
 *
 * Order of evidence: (1) abort/timeout names, (2) STRUCTURED status codes
 * (AI SDK `APICallError.statusCode`), (3) workflow SDK error names,
 * (4) message regex as a last resort. Unknown errors fall through to
 * TERMINAL — they surface to the client immediately instead of silently
 * burning continuation re-invocations.
 */
export function classifyWorkflowError(err: unknown): ClassifiedWorkflowError {
  if (err === null || err === undefined) {
    return { kind: "terminal", message: "Unknown workflow error (empty)" };
  }
  const error = err as Error & { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : String(err);

  // Client cancel / SDK abort — not a failure.
  if (name === "AbortError") return { kind: "abort", message };
  // SDK / provider timeout names — bounded continuation, same as a
  // platform-killed step.
  if (name === "TimeoutError" || name === "StepTimeoutError") {
    return { kind: "timeout", message };
  }

  // ── Structured evidence: AI SDK APICallError carries `statusCode` ────────
  // 429 / 5xx / 409 → transient (queue redelivers). 408 → timeout. Every
  // other 4xx is a deterministic model/request failure — surface it.
  const statusCode =
    typeof error.statusCode === "number" ? error.statusCode : undefined;
  if (statusCode !== undefined) {
    if (statusCode === 408) return { kind: "timeout", message };
    if (statusCode === 429 || statusCode === 409 || statusCode >= 500) {
      return { kind: "transient", message };
    }
    if (statusCode >= 400 && statusCode < 500) {
      return {
        kind: "model",
        message,
        userMessage: `The model call failed: ${displayMessage(message)}`,
      };
    }
  }
  // AI SDK RetryError: the SDK already exhausted its internal retries on a
  // retryable failure — escalate to the workflow queue's redelivery.
  if (name === "AI_RetryError") {
    return { kind: "transient", message };
  }

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

  // Default: unknown errors are TERMINAL — surface them to the client. The
  // old fallthrough classified everything unrecognized as `timeout`, which
  // silently burned two continuation re-invocations before giving up; an
  // error we can't recognize is far more likely a bug than a killed step.
  return {
    kind: "terminal",
    message,
    userMessage:
      "The turn failed with an unexpected error. Please retry — if it keeps happening, check the server logs for the full diagnostic.",
  };
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

// ─── Full-error serialization (log-facing diagnostics) ─────────────────────

/** Cap the stack trace so a pathological error can't flood the log. */
const MAX_STACK_LENGTH = 4000;
/** Depth cap for the recursive `cause` chain. */
const MAX_CAUSE_DEPTH = 5;
/** Length cap for a single serialized field value. */
const MAX_FIELD_LENGTH = 1000;
/**
 * Provider SDK / workflow fields worth surfacing explicitly before the generic
 * props sweep — the AI SDK error classes (AI_APICallError, AI_RetryError,
 * AI_NoSuchModelError) and the @workflow error classes all carry these.
 */
const PROVIDER_FIELDS = [
  "statusCode",
  "requestId",
  "errorId",
  "code",
  "url",
  "isRetryable",
  "retryCount",
  "modelId",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function capValue(s: string, max = MAX_FIELD_LENGTH): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Best-effort stringify of a single field value (never throws). */
function stringifyValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    const s = JSON.stringify(value);
    return s === undefined ? undefined : s;
  } catch {
    // Circular reference — fall back to the native toString.
    return String(value);
  }
}

function indentBlock(s: string, pad = "  "): string {
  return s
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
}

/**
 * Serialize a thrown value into a complete, log-facing diagnostic string —
 * the full detail behind `errorMessage`'s one-liner.
 *
 * IMPORTANT: never `instanceof` — errors crossing the workflow VM realm are
 * distinct objects, so every check is shape/name based (same discipline as
 * `classifyWorkflowError`). Captures name / message / stack, the provider SDK
 * fields above, any JSON-serializable own enumerable properties, and the
 * `cause` chain recursively (bounded). Safe for the "use workflow" sandbox:
 * no Node imports, never throws.
 */
export function formatErrorDetail(err: unknown, depth = 0): string {
  if (!isRecord(err)) {
    if (err === null || err === undefined) return "(no error value)";
    return typeof err === "string"
      ? capValue(err, MAX_STACK_LENGTH)
      : String(err);
  }

  const lines: string[] = [];

  const name = typeof err.name === "string" ? err.name : "(anonymous error)";
  const message = typeof err.message === "string" ? err.message : "";
  lines.push(`name=${name}`);
  if (message) lines.push(`message=${capValue(message)}`);

  if (typeof err.stack === "string" && err.stack.trim()) {
    lines.push(`stack=${capValue(err.stack.trim(), MAX_STACK_LENGTH)}`);
  }

  // Provider / workflow fields (AI_APICallError, WorkflowWorldError, ...).
  for (const key of PROVIDER_FIELDS) {
    const value = err[key];
    if (value === undefined || value === null) continue;
    const serialized = stringifyValue(value);
    if (serialized !== undefined) lines.push(`${key}=${capValue(serialized)}`);
  }

  // Any remaining JSON-serializable own enumerable property (these are the
  // fields a cross-realm serialized error carries that we haven't shown yet).
  const extras: string[] = [];
  for (const key of Object.keys(err)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    if ((PROVIDER_FIELDS as readonly string[]).includes(key)) continue;
    const value = err[key];
    if (value === undefined || value === null) continue;
    const serialized = stringifyValue(value);
    if (serialized === undefined) continue;
    extras.push(`${key}=${capValue(serialized)}`);
  }
  if (extras.length > 0) lines.push(`extra={ ${extras.join(", ")} }`);

  // Cause chain — recursive, indented, bounded.
  const cause = err.cause;
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
    const nested = formatErrorDetail(cause, depth + 1);
    lines.push(`cause:\n${indentBlock(nested)}`);
  }

  return lines.join("\n");
}
