/**
 * Local agent CLI detection — probes PATH for the bridge agent CLIs
 * (claude / codex / kimi) so the client-mode settings UI can show which
 * subscription agents are installed on this machine.
 *
 * Ported from the client CLI's setup-wizard scan, but async and spawn-based
 * (`where` on Windows, `which` elsewhere) with hard timeouts so a hanging
 * binary can never wedge the API route that calls this. Detection is
 * best-effort and honest: a CLI that answers `where`/`which` is `found`,
 * and `--version` is only reported when the probe exits 0 in time.
 *
 * Testability: the probe runner is injectable (DetectOptions.run), so unit
 * tests never touch the real PATH.
 */

import { spawn } from "node:child_process";
import { BRIDGE_AGENTS, type BridgeAgent } from "@/lib/models/registry";

export interface AgentDetection {
  name: BridgeAgent;
  found: boolean;
  /** Resolved executable path (first line of where/which output). */
  path?: string;
  /** First stdout line of `<name> --version`, when it exits 0 in time. */
  version?: string;
}

/** Time budget for the PATH lookup probe. */
export const LOCATE_TIMEOUT_MS = 2_000;
/** Time budget for the `--version` probe — version flags should be instant. */
export const VERSION_TIMEOUT_MS = 3_000;

export interface ProbeResult {
  /** Process exit code, or null when killed (timeout) / never spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure: an errno code ("ENOENT") or "timeout". */
  error?: string;
}

/** Runs argv and captures output. Never rejects — every failure is reported. */
export type ProbeRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<ProbeResult>;

/**
 * Default probe runner: spawn the command, capture stdout/stderr, kill on
 * timeout. Never rejects — mirrors the bridge spawn contract (src/lib/bridge.ts)
 * so a missing or hanging binary degrades to "not found / no version" instead
 * of taking down the detection endpoint.
 */
export const spawnProbe: ProbeRunner = (argv, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(r);
    };

    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      // No console window flash on Windows when probing CLIs.
      windowsHide: true,
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

    timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, error: "timeout" });
    }, timeoutMs);

    child.on("error", (err) => {
      finish({
        code: null,
        stdout,
        stderr,
        error: (err as NodeJS.ErrnoException).code ?? err.message,
      });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** Probe runner override for tests; defaults to the real spawn probe. */
  run?: ProbeRunner;
}

/** First non-empty line of output, or undefined. */
function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * Probe a single agent CLI: locate it on PATH (`where` on Windows, `which`
 * elsewhere), then read its `--version` when that is cheap. A CLI that
 * locates but whose version probe fails is still reported as found — the
 * version is decoration, not evidence.
 */
export async function detectAgent(
  name: BridgeAgent,
  opts: DetectOptions = {},
): Promise<AgentDetection> {
  const run = opts.run ?? spawnProbe;
  const platform = opts.platform ?? process.platform;
  const locator = platform === "win32" ? "where" : "which";

  const located = await run([locator, name], LOCATE_TIMEOUT_MS);
  const path =
    !located.error && located.code === 0 ? firstLine(located.stdout) : undefined;
  if (!path) return { name, found: false };

  const probed = await run([name, "--version"], VERSION_TIMEOUT_MS);
  const version =
    !probed.error && probed.code === 0 ? firstLine(probed.stdout) : undefined;
  return { name, found: true, path, ...(version ? { version } : {}) };
}

/** Probe every bridge agent CLI in parallel. */
export async function detectLocalAgents(
  opts: DetectOptions = {},
): Promise<AgentDetection[]> {
  return Promise.all(BRIDGE_AGENTS.map((name) => detectAgent(name, opts)));
}
