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
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision (Exp)",
    provider: "deepseek",
    providerName: "DeepSeek",
    sdk: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
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

/** Server-side: curated models whose API key env var is set. */
export function getAvailableModels(): ModelConfig[] {
  return ALL_MODELS.filter((m) => !!process.env[m.envKey]);
}

export function getModel(id: string): ModelConfig | undefined {
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
