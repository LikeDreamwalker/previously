/**
 * Subscription bridge — the shared env contract and spawn helper for the
 * operator-controlled local bridge command (client mode only).
 *
 * The bridge command (`PREVIOUSLY_BRIDGE_CMD`, default `previously
 * bridge-exec`) receives a JSON `{ task, context }` payload on stdin and its
 * stdout is the result. It is operator-controlled env — never user/tool
 * input. Two consumers:
 *
 *   - the chat-only `delegateTask` tool (src/app/api/agent/tool-executors.ts)
 *   - the bridge main model (src/lib/models/bridge-model.ts), used when the
 *     deployment runs in "pure subscription" mode (PREVIOUSLY_BRAIN=bridge)
 *     with no model API keys at all
 *
 * Every failure (missing binary, non-zero exit, timeout, empty stdout) comes
 * back as a structured error result — never a fake success (design
 * doc/design/v0.9-client.md §8).
 */

/**
 * NOTE: `node:child_process` is imported lazily INSIDE runBridge — this module
 * rides the workflow bundle's import graph (via src/lib/models/bridge-model.ts
 * ← provider.ts ← agent.ts), and the workflow sandbox VM has no Node builtins
 * at module load. runBridge itself only ever executes in the step runtime.
 */

export const BRIDGE_DEFAULT_CMD = "previously bridge-exec";
export const BRIDGE_DEFAULT_TIMEOUT_MS = 600_000; // 10 min
export const BRIDGE_MAX_OUTPUT_CHARS = 30_000;

/**
 * Wire protocol version sent on stdin (`{ task, context, protocol: 2 }`).
 * Old bridge CLIs ignore the unknown field and keep answering with plain
 * text on stdout (protocol 1). Protocol-2 CLIs answer with NDJSON: zero or
 * more live event lines `{"event": {name, summary, status}}` followed by a
 * final envelope line `{"protocol": 2, "result": string, "events": [...]}`.
 * A single JSON envelope as the whole stdout (no live lines) is also valid.
 */
export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * Result cap for protocol-2 envelopes. The legacy cap (30k) stays for
 * plain-text CLIs; envelopes carry structured reports (recall hits, turn
 * analysis) that legitimately run larger.
 */
export const BRIDGE_MAX_RESULT_CHARS_V2 = 512_000;

/**
 * Acceptance cap on collected protocol-2 events (the client emits at most
 * 100; this leaves headroom while keeping a misbehaving CLI from growing
 * the events array — and the data-phase summaries it feeds — unboundedly).
 */
export const BRIDGE_MAX_EVENTS = 200;

/** One live tool-activity event emitted by a protocol-2 bridge CLI. */
export interface BridgeEvent {
  /** Tool/activity name on the CLI side (e.g. "Read", "Bash"). */
  name: string;
  /** Pre-shortened human line (e.g. "Read memory/2026-08-22-0340.md"). */
  summary: string;
  status: "start" | "ok" | "error";
}

export type BridgeFailureReason =
  | "bridge-not-found"
  | "spawn-failed"
  | "timeout"
  | "exit-code"
  | "empty-output"
  // The CLI answered but ignored the required tool-call JSON tail (used by
  // the bridge model when toolChoice demands a structured report).
  | "invalid-report";

export type BridgeRunResult =
  | {
      status: "ok";
      result: string;
      /** Tool-activity events (protocol 2 only; omitted for legacy CLIs). */
      events?: BridgeEvent[];
      elapsedMs: number;
    }
  | {
      status: "error";
      reason: BridgeFailureReason;
      error: string;
      elapsedMs: number;
    };

/** The bridge command line (operator-controlled env, default `previously bridge-exec`). */
export function getBridgeCommand(): string {
  return process.env.PREVIOUSLY_BRIDGE_CMD?.trim() || BRIDGE_DEFAULT_CMD;
}

/** Bridge timeout: PREVIOUSLY_BRIDGE_TIMEOUT_MS when a positive number, else 10 min. */
export function getBridgeTimeoutMs(): number {
  const raw = Number(process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : BRIDGE_DEFAULT_TIMEOUT_MS;
}

/** Split the bridge command line into argv, honoring double-quoted segments. */
export function splitBridgeCommand(cmd: string): string[] {
  const parts = cmd.match(/"[^"]*"|[^\s"]+/g) ?? [];
  return parts.map((p) =>
    p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p,
  );
}

/**
 * Normalize a raw protocol-2 event object; returns undefined when malformed.
 */
function normalizeBridgeEvent(raw: unknown): BridgeEvent | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== "string" || typeof e.summary !== "string") {
    return undefined;
  }
  const status = e.status;
  if (status !== "start" && status !== "ok" && status !== "error") {
    return undefined;
  }
  return { name: e.name, summary: e.summary, status };
}

/**
 * Spawn the bridge command, pipe the JSON payload to its stdin, and capture
 * stdout as the result. Never rejects — every outcome (missing binary,
 * non-zero exit, timeout, empty stdout) becomes a structured error result so
 * callers can surface it honestly instead of burning workflow retries on a
 * deterministic infrastructure failure.
 *
 * Protocol 2 (see BRIDGE_PROTOCOL_VERSION): stdout is parsed line by line as
 * it arrives. Lines that are single-line JSON objects `{"event": {...}}` are
 * live tool-activity events — forwarded to `onEvent` immediately and
 * collected. A line `{"protocol": 2, "result": ..., "events": [...]}` is the
 * final envelope and settles the run (its `events` are the batch fallback:
 * any beyond the ones already streamed live are flushed to `onEvent` at
 * completion — the client may echo the same events in both places, so the
 * first `streamedEvents.length` envelope events are skipped as duplicates).
 * Without an envelope line the WHOLE raw stdout stays the result (legacy
 * protocol 1), byte-cap 30k; envelope results get the raised 512k cap.
 *
 * `extraEnv` is merged over the inherited process env for this one spawn —
 * used by the bridge main model to pin PREVIOUSLY_BRAIN_AGENT to the agent
 * named by the selected model id (bridge/<agent>), so switching agents via
 * the model selector takes effect on the next call without a restart.
 */
export async function runBridge(
  argv: string[],
  payload: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  onEvent?: (event: BridgeEvent) => void,
): Promise<BridgeRunResult> {
  // Lazy: see the module-level note — never loaded in the workflow sandbox.
  const { spawn } = await import("node:child_process");
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      r:
        | { status: "ok"; result: string; events?: BridgeEvent[] }
        | { status: "error"; reason: BridgeFailureReason; error: string },
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ...r, elapsedMs: Date.now() - start });
    };

    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      // No console window flash on Windows when the kernel spawns the bridge.
      windowsHide: true,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // ── Protocol-2 line parsing (incremental, over the raw capture) ──────
    let lineBuf = "";
    const streamedEvents: BridgeEvent[] = [];
    let envelopeResult: string | undefined;
    let envelopeEvents: BridgeEvent[] | undefined;

    const emitEvent = (ev: BridgeEvent) => {
      try {
        onEvent?.(ev);
      } catch {
        // The callback is a display hook — it must never break the bridge.
      }
    };

    /** Returns true when the line was a protocol line (event or envelope). */
    const parseProtocolLine = (line: string): boolean => {
      const t = line.trim();
      if (!t.startsWith("{")) return false;
      let obj: unknown;
      try {
        obj = JSON.parse(t);
      } catch {
        return false;
      }
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return false;
      }
      const o = obj as Record<string, unknown>;
      if (o.protocol === BRIDGE_PROTOCOL_VERSION && typeof o.result === "string") {
        envelopeResult = o.result;
        if (Array.isArray(o.events)) {
          envelopeEvents = o.events
            .map(normalizeBridgeEvent)
            .filter((e): e is BridgeEvent => e !== undefined);
        }
        return true;
      }
      const ev = normalizeBridgeEvent(o.event);
      if (ev) {
        if (streamedEvents.length < BRIDGE_MAX_EVENTS) {
          streamedEvents.push(ev);
          emitEvent(ev);
        }
        return true;
      }
      return false;
    };

    child.stdout.on("data", (d) => {
      stdout += d;
      lineBuf += d;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        parseProtocolLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    // Best-effort kill on timeout; if the bridge ignores SIGTERM it still
    // lingers, but the caller has already settled with an honest error.
    timer = setTimeout(() => {
      child.kill();
      finish({
        status: "error",
        reason: "timeout",
        error:
          `Bridge timed out after ${timeoutMs}ms and was killed ` +
          `(PREVIOUSLY_BRIDGE_TIMEOUT_MS). The task may be partially done on ` +
          `the bridge side — verify before retrying.`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish({
        status: "error",
        reason: missing ? "bridge-not-found" : "spawn-failed",
        error: missing
          ? `Bridge command not found: "${argv[0]}". Install the client bridge ` +
            `or point PREVIOUSLY_BRIDGE_CMD at it.`
          : `Bridge command failed to start: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(-2000);
        finish({
          status: "error",
          reason: "exit-code",
          error:
            `Bridge exited with code ${code === null ? "null (killed)" : code}.` +
            (tail ? ` stderr: ${tail}` : ""),
        });
        return;
      }
      const out = stdout.trimEnd();
      // A trailing partial line (no final newline) may still be the envelope.
      if (lineBuf.trim()) parseProtocolLine(lineBuf);
      lineBuf = "";
      if (envelopeResult !== undefined) {
        // Protocol 2: the envelope settles the result. Envelope events beyond
        // the ones already streamed live are the batch fallback — flush them
        // now (the CLI may echo the same events in both places; skip the
        // already-streamed prefix as duplicates).
        const fresh = (envelopeEvents ?? [])
          .slice(streamedEvents.length)
          .slice(0, Math.max(0, BRIDGE_MAX_EVENTS - streamedEvents.length));
        for (const ev of fresh) emitEvent(ev);
        const events = [...streamedEvents, ...fresh];
        finish({
          status: "ok",
          result:
            envelopeResult.length > BRIDGE_MAX_RESULT_CHARS_V2
              ? envelopeResult.slice(0, BRIDGE_MAX_RESULT_CHARS_V2) +
                `\n\n(Truncated at ${BRIDGE_MAX_RESULT_CHARS_V2} characters)`
              : envelopeResult,
          ...(events.length > 0 ? { events } : {}),
        });
        return;
      }
      if (!out) {
        finish({
          status: "error",
          reason: "empty-output",
          error: "Bridge exited 0 but produced no output on stdout.",
        });
        return;
      }
      finish({
        status: "ok",
        result:
          out.length > BRIDGE_MAX_OUTPUT_CHARS
            ? out.slice(0, BRIDGE_MAX_OUTPUT_CHARS) +
              `\n\n(Truncated at ${BRIDGE_MAX_OUTPUT_CHARS} characters)`
            : out,
      });
    });

    // The bridge may exit before reading the payload — an EPIPE on stdin is
    // already reported honestly by the close event's non-zero code.
    child.stdin.on("error", () => {});
    child.stdin.write(payload);
    child.stdin.end();
  });
}

// ─── "Pure subscription" brain (PREVIOUSLY_BRAIN=bridge) ──────────────────
//
// The client CLI injects PREVIOUSLY_BRAIN=bridge + PREVIOUSLY_BRAIN_AGENT when
// the user has no model API keys and the kernel's MAIN model must also run
// through the subscription bridge (local Claude/Codex/Kimi CLI). When API keys
// are injected instead, PREVIOUSLY_BRAIN is unset and nothing here activates.
// The gating itself lives in src/lib/models/registry.ts (it decides model
// availability); this module carries only the spawn-side contract.
