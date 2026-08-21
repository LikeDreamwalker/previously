/**
 * Provider dispatch — maps a ModelConfig to a concrete AI SDK LanguageModel.
 *
 * The single construction point for the chat agent's model. Each provider SDK
 * reads its API key from the environment; OpenAI-compatible providers
 * (Kimi, Qwen, Mistral, xAI, ...) get an explicit baseURL + per-provider env
 * key from the catalog.
 */

import { deepseek } from "@ai-sdk/deepseek";
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

// OpenAI-compatible providers share one factory but differ in baseURL + key.
// Cache the provider instances keyed by baseURL + env key.
const openaiProviders = new Map<string, ReturnType<typeof createOpenAI>>();

function getOpenaiProvider(
  baseURL: string | undefined,
  envKey: string,
): ReturnType<typeof createOpenAI> {
  const cacheKey = `${baseURL ?? ""}:${envKey}`;
  let provider = openaiProviders.get(cacheKey);
  if (!provider) {
    provider = createOpenAI({
      ...(baseURL ? { baseURL } : {}),
      apiKey: process.env[envKey],
    });
    openaiProviders.set(cacheKey, provider);
  }
  return provider;
}

export function createModel(config: ModelConfig): LanguageModel {
  switch (config.sdk) {
    case "deepseek":
      return deepseek(config.id);
    case "anthropic":
      return getAnthropicProvider()(config.id);
    case "openai":
      return getOpenaiProvider(config.baseURL, config.envKey)(config.id);
    case "bridge":
      // Local subscription bridge (client mode + PREVIOUSLY_BRAIN=bridge) —
      // the custom LanguageModel shells out to PREVIOUSLY_BRIDGE_CMD.
      return createBridgeLanguageModel(config.id);
    default:
      // Unknown sdk — fall back to DeepSeek with the id verbatim.
      return deepseek(config.id);
  }
}
