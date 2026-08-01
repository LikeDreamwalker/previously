/**
 * Provider dispatch — maps a ModelConfig to a concrete AI SDK LanguageModel.
 *
 * The single construction point for the chat agent's model, replacing the
 * hardcoded `deepseek()` call. Each provider factory reads its own API key from
 * the environment (DEEPSEEK_API_KEY / ANTHROPIC_API_KEY).
 */

import { deepseek } from "@ai-sdk/deepseek";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { ModelConfig } from "./registry";

let _anthropicProvider: ReturnType<typeof createAnthropic> | null = null;

/** createAnthropic({}) reads ANTHROPIC_API_KEY from the environment. */
function getAnthropicProvider() {
  if (!_anthropicProvider) _anthropicProvider = createAnthropic({});
  return _anthropicProvider;
}

export function createModel(config: ModelConfig): LanguageModel {
  switch (config.provider) {
    case "deepseek":
      return deepseek(config.id);
    case "anthropic":
      return getAnthropicProvider()(config.id);
    default:
      // Unknown provider — fall back to DeepSeek with the id verbatim.
      return deepseek(config.id);
  }
}
