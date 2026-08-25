/**
 * Provider dispatch — maps a ModelConfig to a concrete AI SDK LanguageModel.
 *
 * The single construction point for the chat agent's model. Each provider SDK
 * reads its API key from the environment; OpenAI-compatible providers
 * (DeepSeek, Kimi, Qwen, Mistral, xAI, ...) get an explicit baseURL +
 * per-provider env key from the catalog. Only Anthropic keeps a dedicated
 * SDK — everything else speaks the OpenAI-compatible protocol.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createBridgeLanguageModel } from "./bridge-model";
import type { ModelConfig } from "./registry";

let _anthropicProvider: ReturnType<typeof createAnthropic> | null = null;

/** createAnthropic({}) reads ANTHROPIC_API_KEY from the environment. */
function getAnthropicProvider() {
  if (!_anthropicProvider) _anthropicProvider = createAnthropic({});
  return _anthropicProvider;
}

// DeepSeek speaks the OpenAI-compatible protocol via createOpenAICompatible —
// the dedicated @ai-sdk/deepseek SDK silently dropped non-text message parts
// (images never reached the HTTP request), so vision models were blind. The
// provider name MUST stay "deepseek": it becomes the providerOptions key that
// effort-injector.ts emits ({ deepseek: { thinking, reasoningEffort } }).
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

// Cache the provider instances keyed by baseURL + env key + explicit key —
// a changed BYOK apiKey must not reuse a stale cached instance.
const deepseekProviders = new Map<
  string,
  ReturnType<typeof createOpenAICompatible>
>();

function getDeepseekProvider(
  baseURL: string | undefined,
  envKey: string,
  apiKey?: string,
): ReturnType<typeof createOpenAICompatible> {
  const cacheKey = `${baseURL ?? ""}:${envKey}:${apiKey ?? ""}`;
  let provider = deepseekProviders.get(cacheKey);
  if (!provider) {
    provider = createOpenAICompatible({
      name: "deepseek",
      baseURL: baseURL ?? DEEPSEEK_DEFAULT_BASE_URL,
      apiKey: apiKey ?? process.env[envKey],
    });
    deepseekProviders.set(cacheKey, provider);
  }
  return provider;
}

// OpenAI-compatible providers share one factory but differ in baseURL + key.
// Cache the provider instances keyed by baseURL + env key + explicit key.
const openaiProviders = new Map<string, ReturnType<typeof createOpenAI>>();

function getOpenaiProvider(
  baseURL: string | undefined,
  envKey: string,
  apiKey?: string,
): ReturnType<typeof createOpenAI> {
  const cacheKey = `${baseURL ?? ""}:${envKey}:${apiKey ?? ""}`;
  let provider = openaiProviders.get(cacheKey);
  if (!provider) {
    provider = createOpenAI({
      ...(baseURL ? { baseURL } : {}),
      // An explicit config apiKey (BYOK) wins over the environment.
      apiKey: apiKey ?? process.env[envKey],
    });
    openaiProviders.set(cacheKey, provider);
  }
  return provider;
}

export function createModel(config: ModelConfig): LanguageModel {
  switch (config.sdk) {
    case "deepseek":
      return getDeepseekProvider(config.baseURL, config.envKey, config.apiKey)(config.id);
    case "anthropic":
      return getAnthropicProvider()(config.id);
    case "openai":
      // BYOK entries carry the selection id `byok/<model>`; the provider API
      // needs the bare model name.
      return getOpenaiProvider(config.baseURL, config.envKey, config.apiKey)(
        config.id.startsWith("byok/") ? config.id.slice("byok/".length) : config.id,
      );
    case "bridge":
      // Local subscription bridge (client mode + PREVIOUSLY_BRAIN=bridge) —
      // the custom LanguageModel shells out to PREVIOUSLY_BRIDGE_CMD.
      return createBridgeLanguageModel(config.id);
    default:
      // Unknown sdk — fall back to DeepSeek with the id verbatim.
      return getDeepseekProvider(config.baseURL, config.envKey, config.apiKey)(config.id);
  }
}
