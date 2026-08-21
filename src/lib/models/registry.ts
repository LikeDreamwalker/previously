/**
 * Model registry — curated fallback + metadata overlay.
 *
 * The PRIMARY catalog is models.dev (see ./catalog): it lists every provider's
 * models with reasoning/context metadata, and each provider carries its own
 * env var name and baseURL. This file holds the FALLBACK list used when
 * models.dev is unreachable, plus curated overrides (defaultThinking /
 * defaultEffort) applied on top of models.dev entries for known model ids.
 *
 * The Anthropic IDs below mirror the `AnthropicModelId` union shipped inside
 * `@ai-sdk/anthropic` (Anthropic has no list-models API endpoint; the SDK is
 * the curated reference). DeepSeek IDs are the API's own V4 names.
 */

import type { ProviderSdk } from "./providers";
import { isClientMode } from "../mode";

// ─── Bridge brain (pure subscription mode) ────────────────────────────────
//
// When the client CLI injects PREVIOUSLY_BRAIN=bridge, the user has NO model
// API keys and the kernel's main model must run through the local subscription
// bridge (Claude/Codex/Kimi CLI via PREVIOUSLY_BRIDGE_CMD — the spawn contract
// lives in src/lib/bridge.ts). One `bridge/<agent>` entry per known agent is
// registered then, gated on client mode + the env pair; cloud mode never sees
// them. The env-selected agent (PREVIOUSLY_BRAIN_AGENT) is the default — its
// entry comes first — but every installed agent CLI is selectable, and the
// model id (`bridge/<agent>`) decides which CLI a given call spawns (see
// src/lib/models/bridge-model.ts), so switching agents needs no restart.

/** Subscription CLI agents the bridge can drive. */
export const BRIDGE_AGENTS = ["claude", "codex", "kimi"] as const;
export type BridgeAgent = (typeof BRIDGE_AGENTS)[number];
export const BRIDGE_DEFAULT_AGENT: BridgeAgent = "claude";

/** Display names of the subscription CLIs, for hints and tooltips. */
export const BRIDGE_AGENT_LABELS: Record<BridgeAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
};

/**
 * The selected bridge agent (PREVIOUSLY_BRAIN_AGENT). Unknown values fall
 * back to the default rather than failing — the env is injected by the
 * client CLI, and a typo shouldn't take the whole kernel down.
 */
export function getBridgeAgent(): BridgeAgent {
  const raw = process.env.PREVIOUSLY_BRAIN_AGENT?.trim();
  return (BRIDGE_AGENTS as readonly string[]).includes(raw ?? "")
    ? (raw as BridgeAgent)
    : BRIDGE_DEFAULT_AGENT;
}

/**
 * Is the "pure subscription" brain active? Only in client mode AND with
 * PREVIOUSLY_BRAIN=bridge explicitly set — cloud mode is byte-for-byte
 * unaffected, and a client with real API keys (PREVIOUSLY_BRAIN unset) keeps
 * the normal AI SDK path.
 */
export function isBridgeBrainActive(): boolean {
  return isClientMode() && process.env.PREVIOUSLY_BRAIN === "bridge";
}

/**
 * The bridge agent for a model id: `bridge/<agent>` selects that agent;
 * anything else (bare `bridge`, unknown agent, non-bridge id) falls back to
 * the env-selected agent rather than failing — a stale or hand-edited stored
 * preference shouldn't take the kernel down.
 */
export function bridgeAgentFromModelId(id: string): BridgeAgent {
  const agent = id.startsWith("bridge/") ? id.slice("bridge/".length) : "";
  return (BRIDGE_AGENTS as readonly string[]).includes(agent)
    ? (agent as BridgeAgent)
    : getBridgeAgent();
}

/** One registry entry per subscription agent CLI. */
function bridgeModelConfig(agent: BridgeAgent): ModelConfig {
  return {
    id: `bridge/${agent}`,
    name: `${agent.charAt(0).toUpperCase() + agent.slice(1)} (subscription bridge)`,
    provider: "bridge",
    providerName: "Subscription Bridge",
    sdk: "bridge",
    envKey: "PREVIOUSLY_BRAIN",
    capabilities: {
      // The bridge CLI returns plain text — no structured thinking stream,
      // no vision. maxTokens is a nominal display value; the true output cap
      // is the bridge's 30KB stdout limit (src/lib/bridge.ts).
      thinking: false,
      vision: false,
      maxTokens: 200_000,
    },
    defaultThinking: false,
    defaultEffort: "low",
  };
}

/**
 * The bridge main-model entries (`bridge/<agent>` for every known agent), or
 * [] when the bridge brain is not active. The env-selected agent comes first
 * so getAvailableModels()[0] / getDefaultModelId() resolve to it. envKey is
 * informational — availability is gated by isBridgeBrainActive(), not by an
 * API key.
 */
export function getBridgeModels(): ModelConfig[] {
  if (!isBridgeBrainActive()) return [];
  const first = getBridgeAgent();
  const rest = BRIDGE_AGENTS.filter((a) => a !== first);
  return [first, ...rest].map(bridgeModelConfig);
}

/**
 * Compat wrapper for the pre-multi-agent shape: the env-selected agent's
 * entry (= getBridgeModels()[0]), or undefined when inactive.
 */
export function getBridgeModel(): ModelConfig | undefined {
  return getBridgeModels()[0];
}

export interface ModelCapabilities {
  thinking: boolean;
  vision: boolean;
  maxTokens: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  /** models.dev provider key, e.g. "deepseek", "anthropic", "moonshotai". */
  provider: string;
  /** Display name for the provider group in the selector. */
  providerName: string;
  /** Which AI SDK factory constructs the model (see providers.ts). */
  sdk: ProviderSdk;
  /** Env var that must be set for this model to be available. */
  envKey: string;
  /** Base URL for OpenAI-compatible providers; undefined for dedicated SDKs. */
  baseURL?: string;
  capabilities: ModelCapabilities;
  /** Default thinking state when the user selects this model. */
  defaultThinking: boolean;
  /** Default reasoning effort when the user selects this model. */
  defaultEffort: "low" | "medium" | "high";
}

/**
 * Curated fallback catalog — used only when models.dev is unreachable. Client
 * components may import this for types and the static list (a plain array with
 * no process.env access at module load), but availability filtering is
 * server-side.
 */
export const ALL_MODELS: ModelConfig[] = [
  // ── DeepSeek ────────────────────────────────────────────────────────────
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    providerName: "DeepSeek",
    sdk: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    defaultThinking: true,
    defaultEffort: "low",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    providerName: "DeepSeek",
    sdk: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    defaultThinking: true,
    // DeepSeek exposes only low/high as meaningful tiers (V4 Pro promotes
    // low/medium to high server-side) — the UI cycles between these two, so
    // the stored default must live inside that set.
    defaultEffort: "high",
  },
  // ── Anthropic (curated from @ai-sdk/anthropic's AnthropicModelId union) ─
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    providerName: "Anthropic",
    sdk: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    capabilities: { thinking: true, vision: true, maxTokens: 200000 },
    defaultThinking: true,
    defaultEffort: "low",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    providerName: "Anthropic",
    sdk: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    capabilities: { thinking: true, vision: true, maxTokens: 200000 },
    defaultThinking: true,
    defaultEffort: "medium",
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "anthropic",
    providerName: "Anthropic",
    sdk: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    capabilities: { thinking: true, vision: true, maxTokens: 200000 },
    defaultThinking: true,
    defaultEffort: "high",
  },
];

/**
 * Curated metadata overrides keyed by model id, applied on top of models.dev
 * entries. Thinking is NOT overridden here — it derives from the model's
 * capability (models.dev `reasoning`), so every thinking-capable model defaults
 * to thinking ON. These only pin the effort level where we want a specific
 * value rather than the `reasoning ? "medium" : "low"` heuristic.
 */
const MODEL_OVERRIDES: Record<
  string,
  Partial<Pick<ModelConfig, "defaultThinking" | "defaultEffort">>
> = {
  "deepseek-v4-flash": { defaultEffort: "low" },
  // Pro's medium is promoted to high server-side, so pin it inside the
  // low/high UI set rather than an unreachable middle tier.
  "deepseek-v4-pro": { defaultEffort: "high" },
};

/** Curated override for a known model id, if any. */
export function getModelOverrides(
  id: string,
): Partial<Pick<ModelConfig, "defaultThinking" | "defaultEffort">> | undefined {
  return MODEL_OVERRIDES[id];
}

/** Server-side: curated models whose API key env var is set, plus the bridge
 *  brain entries when pure subscription mode is active. */
export function getAvailableModels(): ModelConfig[] {
  const keyed = ALL_MODELS.filter((m) => !!process.env[m.envKey]);
  return [...keyed, ...getBridgeModels()];
}

export function getModel(id: string): ModelConfig | undefined {
  const bridge = getBridgeModels().find((m) => m.id === id);
  if (bridge) return bridge;
  return ALL_MODELS.find((m) => m.id === id);
}

/**
 * Normalize a stored model id to its current successor. The client's stored
 * preference may predate V4 — map the legacy OpenAI-style names forward.
 */
const MODEL_ALIASES: Record<string, string> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
};

export function resolveModelId(id: string): string {
  return MODEL_ALIASES[id] ?? id;
}

/** First available model (server-side), for deployments with no stored pref. */
export function getDefaultModelId(): string {
  return getAvailableModels()[0]?.id ?? ALL_MODELS[0].id;
}
