/**
 * Model registry — multi-provider model definitions with capabilities.
 *
 * This is the CURATED METADATA layer: display name, provider, capabilities,
 * and the env var that gates availability. Capabilities (thinking/vision/
 * maxTokens) cannot be discovered dynamically — every provider's list-models
 * API omits them — so this small table is the source of truth for what the
 * selector shows and how the agent calls each model.
 *
 * The Anthropic IDs below mirror the `AnthropicModelId` union shipped inside
 * `@ai-sdk/anthropic` (Anthropic has no list-models API endpoint; the SDK is
 * the curated reference). Upgrade the SDK and the new IDs appear in that union
 * to curate against. DeepSeek model IDs are additionally refreshed at runtime
 * from its OpenAI-compatible `/models` endpoint — see ./catalog.
 */

export interface ModelCapabilities {
  thinking: boolean;
  vision: boolean;
  maxTokens: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: "deepseek" | "anthropic" | "openai";
  capabilities: ModelCapabilities;
  /** Env var that must be set for this model to be available. */
  envKey: string;
  /** Default thinking state when the user selects this model. */
  defaultThinking: boolean;
  /** Default reasoning effort when the user selects this model. */
  defaultEffort: "low" | "medium" | "high";
}

/**
 * Full curated catalog. Client components may import this for types and the
 * static list (it is a plain array with no process.env access at module load),
 * but availability filtering happens server-side.
 */
export const ALL_MODELS: ModelConfig[] = [
  // ── DeepSeek ────────────────────────────────────────────────────────────
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    envKey: "DEEPSEEK_API_KEY",
    defaultThinking: false,
    defaultEffort: "low",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    envKey: "DEEPSEEK_API_KEY",
    defaultThinking: true,
    defaultEffort: "medium",
  },
  // ── Anthropic (curated from @ai-sdk/anthropic's AnthropicModelId union) ─
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    capabilities: { thinking: true, vision: true, maxTokens: 200000 },
    envKey: "ANTHROPIC_API_KEY",
    defaultThinking: false,
    defaultEffort: "low",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    capabilities: { thinking: true, vision: true, maxTokens: 200000 },
    envKey: "ANTHROPIC_API_KEY",
    defaultThinking: true,
    defaultEffort: "medium",
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "anthropic",
    capabilities: { thinking: true, vision: true, maxTokens: 200000 },
    envKey: "ANTHROPIC_API_KEY",
    defaultThinking: true,
    defaultEffort: "high",
  },
];

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
