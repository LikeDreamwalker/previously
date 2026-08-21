/**
 * Client home config — read/write `PREVIOUSLY_HOME/config.json` (client mode
 * only; the routes under src/app/api/client/ are the only callers).
 *
 * PREVIOUSLY_HOME is the client state root injected by the client CLI
 * (~/.previously). Its config.json is owned by the client but the kernel may
 * read it (status display) and update two fields (executionBackend, brain)
 * from the settings UI. Unknown fields are preserved verbatim on write.
 *
 * Honesty rules: a missing PREVIOUSLY_HOME is reported as null fields, a
 * missing file as exists:false, an unreadable/corrupt file as a thrown error
 * — never a fabricated default that looks like real state.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BRIDGE_AGENTS, type BridgeAgent } from "@/lib/models/registry";

/** The `brain` field of the client config (subscription vs. API-key brain). */
export type ClientBrain =
  | { type: "api-key"; env: string; model?: string }
  | { type: "bridge"; agent: BridgeAgent };

/**
 * The client config.json shape. Only the fields the kernel understands are
 * typed; everything else passes through untouched (index signature).
 */
export interface ClientConfigFile {
  storage?: string;
  memoryRoot?: string;
  port?: number;
  hostname?: string;
  executionBackend?: string | null;
  brain?: ClientBrain;
  apiKeys?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClientConfigSnapshot {
  /** PREVIOUSLY_HOME, or null when the env var is not set. */
  home: string | null;
  /** Absolute path of config.json, or null when there is no home. */
  path: string | null;
  /** Whether config.json exists and parsed. */
  exists: boolean;
  executionBackend: string | null;
  brain: ClientBrain | null;
}

/** Error with an HTTP status hint for the route layer (400 = caller error). */
export class ClientConfigError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The client state root (PREVIOUSLY_HOME), or null when unset. */
export function getPreviouslyHome(): string | null {
  const home = process.env.PREVIOUSLY_HOME?.trim();
  return home || null;
}

function getClientConfigPath(): string | null {
  const home = getPreviouslyHome();
  return home ? join(home, "config.json") : null;
}

/** Lenient read-side brain parse: returned only when structurally recognizable. */
function parseBrain(raw: unknown): ClientBrain | null {
  if (!raw || typeof raw !== "object") return null;
  const brain = raw as Record<string, unknown>;
  if (brain.type === "api-key" && typeof brain.env === "string") {
    return {
      type: "api-key",
      env: brain.env,
      ...(typeof brain.model === "string" ? { model: brain.model } : {}),
    };
  }
  if (
    brain.type === "bridge" &&
    typeof brain.agent === "string" &&
    (BRIDGE_AGENTS as readonly string[]).includes(brain.agent)
  ) {
    return { type: "bridge", agent: brain.agent as BridgeAgent };
  }
  return null;
}

/** Read the current client config. Never fabricates state. */
export async function readClientConfig(): Promise<ClientConfigSnapshot> {
  const home = getPreviouslyHome();
  const path = getClientConfigPath();
  if (!home || !path) {
    return { home, path, exists: false, executionBackend: null, brain: null };
  }

  let raw: ClientConfigFile;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as ClientConfigFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { home, path, exists: false, executionBackend: null, brain: null };
    }
    throw new ClientConfigError(
      `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  return {
    home,
    path,
    exists: true,
    executionBackend:
      typeof raw.executionBackend === "string" ? raw.executionBackend : null,
    brain: parseBrain(raw.brain),
  };
}

/** Strict write-side brain validation. Returns the value to store. */
function validateBrain(input: unknown): ClientBrain {
  if (!input || typeof input !== "object") {
    throw new ClientConfigError('brain must be an object like { "type": "api-key", "env": "…" } or { "type": "bridge", "agent": "…" }');
  }
  const brain = input as Record<string, unknown>;
  if (brain.type === "api-key") {
    const env = typeof brain.env === "string" ? brain.env.trim() : "";
    if (!env) {
      throw new ClientConfigError('brain.env must be a non-empty env var name (e.g. "DEEPSEEK_API_KEY")');
    }
    if (brain.model !== undefined && typeof brain.model !== "string") {
      throw new ClientConfigError("brain.model must be a string when present");
    }
    return {
      type: "api-key",
      env,
      ...(typeof brain.model === "string" && brain.model.trim()
        ? { model: brain.model.trim() }
        : {}),
    };
  }
  if (brain.type === "bridge") {
    if (
      typeof brain.agent !== "string" ||
      !(BRIDGE_AGENTS as readonly string[]).includes(brain.agent)
    ) {
      throw new ClientConfigError(
        `brain.agent must be one of: ${BRIDGE_AGENTS.join(", ")}`,
      );
    }
    return { type: "bridge", agent: brain.agent as BridgeAgent };
  }
  throw new ClientConfigError('brain.type must be "api-key" or "bridge"');
}

/**
 * Field update tri-state per key: absent → leave unchanged; null → clear
 * (executionBackend → null, brain → field removed); value → validate + set.
 */
export interface ClientConfigPatch {
  executionBackend?: string | null;
  brain?: ClientBrain | null;
}

/**
 * Merge a validated patch into PREVIOUSLY_HOME/config.json, preserving every
 * unmanaged field. Creates the file (and home dir) when missing. Throws
 * ClientConfigError with an honest message on any validation or I/O failure.
 */
export async function writeClientConfig(
  patch: ClientConfigPatch,
): Promise<ClientConfigSnapshot> {
  const home = getPreviouslyHome();
  const path = getClientConfigPath();
  if (!home || !path) {
    throw new ClientConfigError(
      "PREVIOUSLY_HOME is not set — the client CLI injects it when starting the kernel.",
    );
  }

  // Validate BEFORE touching the disk.
  let executionBackend: string | null | undefined;
  if ("executionBackend" in patch) {
    const value = patch.executionBackend;
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      throw new ClientConfigError(
        "executionBackend must be a non-empty string or null",
      );
    }
    executionBackend = value === null ? null : value.trim();
  }
  let brain: ClientBrain | null | undefined;
  if ("brain" in patch) {
    brain = patch.brain === null ? null : validateBrain(patch.brain);
  }

  let raw: ClientConfigFile = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as ClientConfigFile;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ClientConfigError(`${path} does not contain a JSON object`, 500);
    }
  } catch (e) {
    if (e instanceof ClientConfigError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ClientConfigError(
        `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`,
        500,
      );
    }
    // ENOENT → start from an empty config.
  }

  const merged: ClientConfigFile = { ...raw };
  if (executionBackend !== undefined) merged.executionBackend = executionBackend;
  if (brain !== undefined) {
    if (brain === null) delete merged.brain;
    else merged.brain = brain;
  }

  try {
    await mkdir(home, { recursive: true });
    await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  } catch (e) {
    throw new ClientConfigError(
      `Could not write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  return readClientConfig();
}
