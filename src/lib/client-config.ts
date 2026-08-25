/**
 * Client home config — read/write `PREVIOUSLY_HOME/config.json` (client mode
 * only; the routes under src/app/api/client/ are the only callers).
 *
 * PREVIOUSLY_HOME is the client state root injected by the client CLI
 * (~/.previously). Its config.json is owned by the client but the kernel may
 * read it (status display; the model catalog reads the `byok` section
 * through readClientConfig) and update four fields (executionBackend,
 * brain, agents, byok) from the settings UI. Unknown fields are preserved
 * verbatim on write.
 *
 * Honesty rules: a missing PREVIOUSLY_HOME is reported as null fields, a
 * missing file as exists:false, an unreadable/corrupt file as a thrown error
 * — never a fabricated default that looks like real state.
 */

import { readFile, writeFile, rename, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BRIDGE_AGENTS,
  BYOK_PROVIDERS,
  type BridgeAgent,
} from "@/lib/models/registry";

/** The `brain` field of the client config (subscription vs. API-key brain). */
export type ClientBrain =
  | { type: "api-key"; env: string; model?: string }
  | { type: "bridge"; agent: BridgeAgent };

/** Thinking effort a bridge agent CLI accepts. Kimi has no effort knob. */
export type BridgeEffort = "low" | "medium" | "high";
export const BRIDGE_EFFORTS: readonly BridgeEffort[] = ["low", "medium", "high"];

/** Per-agent bridge defaults: model for every agent, effort for claude/codex. */
export interface AgentConfig {
  model?: string;
  effort?: BridgeEffort;
}

/** The `agents` field of the client config, keyed by bridge agent. */
export type ClientAgents = Partial<Record<BridgeAgent, AgentConfig>>;

/**
 * The `byok` field of the client config — the user's own provider API key
 * (client mode's second engine, recommended next to local agent outsourcing).
 * `provider` is a BYOK_PROVIDERS key or "custom" (which requires baseUrl).
 * The apiKey is stored in plaintext — config.json is local single-user state.
 */
export interface ClientByok {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

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
  byok?: ClientByok;
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
  /** Per-agent bridge defaults, or null when absent/unrecognizable. */
  agents: ClientAgents | null;
  /**
   * The BYOK section, or null when absent/unrecognizable. The apiKey is
   * returned in plaintext by the local GET endpoint — acceptable because the
   * kernel is single-user local state (same trust level as config.json
   * itself); never log it.
   */
  byok: ClientByok | null;
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

/** Lenient read-side agents parse: only structurally recognized entries surface. */
function parseAgents(raw: unknown): ClientAgents | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const agents: ClientAgents = {};
  for (const name of BRIDGE_AGENTS) {
    const entry = input[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const parsed: AgentConfig = {};
    if (typeof e.model === "string" && e.model.trim()) parsed.model = e.model;
    if (
      name !== "kimi" &&
      typeof e.effort === "string" &&
      (BRIDGE_EFFORTS as readonly string[]).includes(e.effort)
    ) {
      parsed.effort = e.effort as BridgeEffort;
    }
    if (parsed.model !== undefined || parsed.effort !== undefined) {
      agents[name] = parsed;
    }
  }
  return Object.keys(agents).length > 0 ? agents : null;
}

/** Lenient read-side byok parse: returned only when structurally recognizable. */
function parseByok(raw: unknown): ClientByok | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.provider !== "string" || !b.provider.trim()) return null;
  if (typeof b.apiKey !== "string" || !b.apiKey) return null;
  if (typeof b.model !== "string" || !b.model.trim()) return null;
  return {
    provider: b.provider,
    apiKey: b.apiKey,
    ...(typeof b.baseUrl === "string" && b.baseUrl.trim()
      ? { baseUrl: b.baseUrl }
      : {}),
    model: b.model,
  };
}

/** Read the current client config. Never fabricates state. */
export async function readClientConfig(): Promise<ClientConfigSnapshot> {
  const home = getPreviouslyHome();
  const path = getClientConfigPath();
  if (!home || !path) {
    return { home, path, exists: false, executionBackend: null, brain: null, agents: null, byok: null };
  }

  let raw: ClientConfigFile;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as ClientConfigFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { home, path, exists: false, executionBackend: null, brain: null, agents: null, byok: null };
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
    agents: parseAgents(raw.agents),
    byok: parseByok(raw.byok),
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
 * Strict write-side agents validation. Returns the value to store. Each key
 * must be a known bridge agent; each entry accepts `model` (non-empty string)
 * for every agent and `effort` (low|medium|high) for claude/codex only — the
 * Kimi CLI has no effort knob, so `kimi.effort` is rejected, not dropped.
 */
function validateAgents(input: unknown): ClientAgents {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClientConfigError(
      'agents must be an object like { "claude": { "model": "…", "effort": "low" } }',
    );
  }
  const input2 = input as Record<string, unknown>;
  const agents: ClientAgents = {};
  for (const [name, value] of Object.entries(input2)) {
    if (!(BRIDGE_AGENTS as readonly string[]).includes(name)) {
      throw new ClientConfigError(
        `agents.${name} — unknown agent (expected one of: ${BRIDGE_AGENTS.join(", ")})`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ClientConfigError(`agents.${name} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "model" && key !== "effort") {
        throw new ClientConfigError(`agents.${name}.${key} is not a supported field`);
      }
    }
    const parsed: AgentConfig = {};
    if (entry.model !== undefined) {
      if (typeof entry.model !== "string" || !entry.model.trim()) {
        throw new ClientConfigError(`agents.${name}.model must be a non-empty string`);
      }
      parsed.model = entry.model.trim();
    }
    if (entry.effort !== undefined) {
      if (
        typeof entry.effort !== "string" ||
        !(BRIDGE_EFFORTS as readonly string[]).includes(entry.effort)
      ) {
        throw new ClientConfigError(
          `agents.${name}.effort must be one of: ${BRIDGE_EFFORTS.join(", ")}`,
        );
      }
      if (name === "kimi") {
        throw new ClientConfigError("agents.kimi.effort is not supported by the Kimi CLI");
      }
      parsed.effort = entry.effort as BridgeEffort;
    }
    if (parsed.model !== undefined || parsed.effort !== undefined) {
      agents[name as BridgeAgent] = parsed;
    }
  }
  return agents;
}

/**
 * Strict write-side byok validation. Returns the value to store. `provider`
 * is required and must be a BYOK_PROVIDERS key or "custom" (custom requires
 * `baseUrl`); `apiKey` and `model` are required non-empty. Unknown fields are
 * rejected, not dropped (same discipline as validateAgents).
 */
function validateByok(input: unknown): ClientByok {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClientConfigError(
      'byok must be an object like { "provider": "deepseek", "apiKey": "…", "model": "…" }',
    );
  }
  const b = input as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (key !== "provider" && key !== "apiKey" && key !== "baseUrl" && key !== "model") {
      throw new ClientConfigError(`byok.${key} is not a supported field`);
    }
  }
  const provider = typeof b.provider === "string" ? b.provider.trim() : "";
  if (!provider) {
    throw new ClientConfigError("byok.provider must be a non-empty string");
  }
  if (
    provider !== "custom" &&
    !(BYOK_PROVIDERS as readonly { key: string }[]).some((p) => p.key === provider)
  ) {
    throw new ClientConfigError(
      `byok.provider must be one of: ${BYOK_PROVIDERS.map((p) => p.key).join(", ")}, custom`,
    );
  }
  const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim() : "";
  if (provider === "custom" && !baseUrl) {
    throw new ClientConfigError('byok.baseUrl is required when provider is "custom"');
  }
  const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
  if (!apiKey) {
    throw new ClientConfigError("byok.apiKey must be a non-empty string");
  }
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!model) {
    throw new ClientConfigError("byok.model must be a non-empty string");
  }
  return { provider, apiKey, ...(baseUrl ? { baseUrl } : {}), model };
}

/**
 * Field update tri-state per key: absent → leave unchanged; null → clear
 * (executionBackend → null, brain/agents/byok → field removed); value → validate + set.
 */
export interface ClientConfigPatch {
  executionBackend?: string | null;
  brain?: ClientBrain | null;
  agents?: ClientAgents | null;
  byok?: ClientByok | null;
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
  let agents: ClientAgents | null | undefined;
  if ("agents" in patch) {
    agents = patch.agents === null ? null : validateAgents(patch.agents);
  }
  let byok: ClientByok | null | undefined;
  if ("byok" in patch) {
    byok = patch.byok === null ? null : validateByok(patch.byok);
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
  if (agents !== undefined) {
    if (agents === null) delete merged.agents;
    else merged.agents = agents;
  }
  if (byok !== undefined) {
    if (byok === null) delete merged.byok;
    else merged.byok = byok;
  }

  try {
    await mkdir(home, { recursive: true });
    // Atomic write: tmp file + rename, so a concurrent reader (e.g. a
    // parallel GET /api/client/config) never sees a half-written file.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
    try {
      await rename(tmp, path);
    } catch {
      // Windows can EPERM on rename-over-existing when the target is
      // transiently locked (AV scan, a concurrent reader); fall back to a
      // direct overwrite rather than failing the save.
      await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
      await rm(tmp, { force: true });
    }
  } catch (e) {
    throw new ClientConfigError(
      `Could not write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  return readClientConfig();
}
