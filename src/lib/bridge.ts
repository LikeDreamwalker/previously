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

export type BridgeFailureReason =
  | "bridge-not-found"
  | "spawn-failed"
  | "timeout"
  | "exit-code"
  | "empty-output";

export type BridgeRunResult =
  | { status: "ok"; result: string; elapsedMs: number }
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
 * Spawn the bridge command, pipe the JSON payload to its stdin, and capture
 * stdout as the result. Never rejects — every outcome (missing binary,
 * non-zero exit, timeout, empty stdout) becomes a structured error result so
 * callers can surface it honestly instead of burning workflow retries on a
 * deterministic infrastructure failure.
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
): Promise<BridgeRunResult> {
  // Lazy: see the module-level note — never loaded in the workflow sandbox.
  const { spawn } = await import("node:child_process");
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      r:
        | { status: "ok"; result: string }
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
    child.stdout.on("data", (d) => {
      stdout += d;
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
