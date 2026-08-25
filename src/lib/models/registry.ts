/**
 * Model registry — curated fallback + metadata overlay.
 *
 * The PRIMARY catalog is models.dev (see ./catalog): it lists every provider's
 * models with reasoning/context metadata, and each provider carries its own
 * env var name and baseURL. This file holds the FALLBACK list used when
 * models.dev is unreachable.
 *
 * Thinking/effort defaults: every user-selectable model defaults to thinking
 * ON (where the capability exists) at LOW effort — fast responses are the
 * product rule; deep thinking is thinkDeep's job. startTurn pins these values
 * server-side regardless of the request body or stored config.
 *
 * The Anthropic IDs below mirror the `AnthropicModelId` union shipped inside
 * `@ai-sdk/anthropic` (Anthropic has no list-models API endpoint; the SDK is
 * the curated reference). DeepSeek IDs are the API's own V4 names.
 */

import type { ProviderSdk } from "./providers";
import type { ClientBrain, ClientByok } from "../client-config";
import { isClientMode } from "../mode";

// ─── Local agent engine (pure subscription mode) ──────────────────────────
//
// The main model can run through the local subscription bridge (Claude/Codex/
// Kimi CLI via PREVIOUSLY_BRIDGE_CMD — the spawn contract lives in
// src/lib/bridge.ts). One `bridge/<agent>` entry per known agent is registered
// when the engine is active, gated on client mode; cloud mode never sees them.
//
// The engine is active when EITHER the client CLI injected
// PREVIOUSLY_BRAIN=bridge at spawn time OR config.json says
// brain.type === "bridge" (the settings UI's engine switch — hot, no
// restart). The config brain wins over the env for the DEFAULT agent ordering
// (it's the fresher, user-editable source), but the model id
// (`bridge/<agent>`) decides which CLI a given call spawns (see
// src/lib/models/bridge-model.ts), so switching agents needs no restart.
//
// fs-freedom contract: these helpers are PURE — the caller reads config.json
// (catalog.ts, async server path) and passes the brain in. Sync callers that
// omit it keep env-only behavior.

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
 * The default bridge agent. The config brain (`brain.agent` from
 * config.json) wins over PREVIOUSLY_BRAIN_AGENT when present; unknown env
 * values fall back to the default rather than failing — the env is injected
 * by the client CLI, and a typo shouldn't take the whole kernel down.
 */
export function getBridgeAgent(brain?: ClientBrain | null): BridgeAgent {
  if (brain?.type === "bridge") return brain.agent;
  const raw = process.env.PREVIOUSLY_BRAIN_AGENT?.trim();
  return (BRIDGE_AGENTS as readonly string[]).includes(raw ?? "")
    ? (raw as BridgeAgent)
    : BRIDGE_DEFAULT_AGENT;
}

/**
 * Is the local agent engine (pure subscription) active? Client mode AND
 * either PREVIOUSLY_BRAIN=bridge (injected by the client CLI) or
 * brain.type === "bridge" in config.json (the settings-UI engine switch) —
 * either source suffices, so saving the engine in settings takes effect
 * without a restart. Callers without the config at hand (sync paths) omit
 * `brain` and keep env-only behavior; cloud mode is byte-for-byte
 * unaffected, and a client with real API keys keeps the normal AI SDK path.
 */
export function isBridgeBrainActive(brain?: ClientBrain | null): boolean {
  return (
    isClientMode() &&
    (process.env.PREVIOUSLY_BRAIN === "bridge" || brain?.type === "bridge")
  );
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
 * The local-agent engine entries (`bridge/<agent>` for every known agent), or
 * [] when the engine is not active. The default agent (config brain first,
 * then env) comes first so getAvailableModels()[0] / getDefaultModelId()
 * resolve to it. envKey is informational — availability is gated by
 * isBridgeBrainActive(), not by an API key.
 */
export function getBridgeModels(brain?: ClientBrain | null): ModelConfig[] {
  if (!isBridgeBrainActive(brain)) return [];
  const first = getBridgeAgent(brain);
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

// ─── BYOK (bring-your-own-key, client mode) ───────────────────────────────
//
// Client mode's second engine next to local agent outsourcing (the bridge):
// the user's own provider API key, stored in PREVIOUSLY_HOME/config.json (the
// `byok` section — see src/lib/client-config.ts). One entry, `byok/<model>`,
// listed after the bridge entries (agent outsourcing is the default; BYOK is
// the recommended full-capability path). Cloud mode never sees it.
//
// sdk is ALWAYS "openai" (OpenAI-compatible — DeepSeek included): the
// workflow step runtime round-trips the model through class serialization,
// and only the openai path's deserializer restores the apiKey from the
// serialized config (src/app/api/agent/register-model-classes.ts) — the
// deepseek/anthropic paths re-read the key from env and would lose it. The
// tradeoff: BYOK v1 forgoes the deepseek path's prefix-caching provider
// options.

/**
 * BYOK provider presets — mirror the openaiBaseURL table in ./catalog.ts
 * (SOURCES), kept here so BYOK resolution stays free of the catalog's fetch
 * machinery. "custom" takes the user-supplied baseUrl instead.
 */
export const BYOK_PROVIDERS = [
  { key: "deepseek", providerName: "DeepSeek", baseURL: "https://api.deepseek.com" },
  { key: "openai", providerName: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { key: "moonshotai", providerName: "Moonshot AI", baseURL: "https://api.moonshot.cn/v1" },
  { key: "alibaba", providerName: "Alibaba", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { key: "google", providerName: "Google", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { key: "mistral", providerName: "Mistral", baseURL: "https://api.mistral.ai/v1" },
  { key: "xai", providerName: "xAI", baseURL: "https://api.x.ai/v1" },
  { key: "groq", providerName: "Groq", baseURL: "https://api.groq.com/openai/v1" },
] as const;

/**
 * The BYOK model entry (`byok/<model>`) for the given `byok` config section,
 * or undefined in cloud mode / without one. Pure — the caller reads
 * config.json (catalog.ts, async) so this module stays fs-free. Capabilities
 * stay conservative: BYOK providers' features are unknown to the kernel.
 */
export function getByokModel(
  byok: ClientByok | null | undefined,
): ModelConfig | undefined {
  if (!isClientMode() || !byok) return undefined;
  const preset = BYOK_PROVIDERS.find((p) => p.key === byok.provider);
  return {
    id: `byok/${byok.model}`,
    name: `${byok.model} (BYOK)`,
    provider: "byok",
    providerName: "Your API key",
    sdk: "openai",
    // No env var backs this model — the key comes from config.json (apiKey).
    envKey: "",
    baseURL:
      byok.provider === "custom"
        ? byok.baseUrl
        : (preset?.baseURL ?? byok.baseUrl),
    apiKey: byok.apiKey,
    capabilities: { thinking: false, vision: false, maxTokens: 200_000 },
    defaultThinking: false,
    defaultEffort: "low",
  };
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
  /** Base URL for OpenAI-compatible providers (DeepSeek included). */
  baseURL?: string;
  /**
   * Explicit API key (BYOK only) — takes precedence over process.env[envKey]
   * in createModel. Never logged.
   */
  apiKey?: string;
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
    baseURL: "https://api.deepseek.com",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    defaultThinking: true,
    defaultEffort: "low",
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision (Exp)",
    provider: "deepseek",
    providerName: "DeepSeek",
    sdk: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com",
    capabilities: { thinking: true, vision: true, maxTokens: 393216 },
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
    baseURL: "https://api.deepseek.com",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    defaultThinking: true,
    defaultEffort: "low",
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
    defaultEffort: "low",
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
    defaultEffort: "low",
  },
];

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
