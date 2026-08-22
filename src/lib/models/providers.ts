/**
 * Provider routing — maps a models.dev provider key to the AI SDK factory
 * needed to call its models.
 *
 * Most providers expose an OpenAI-compatible endpoint and can be called via
 * `@ai-sdk/openai`'s `createOpenAI({ baseURL, apiKey })`; baseURL and env var
 * come from models.dev (see ./catalog). Only Anthropic is routed to its
 * dedicated SDK. DeepSeek keeps "deepseek" as its routing key but is built via
 * `@ai-sdk/openai-compatible` (`createOpenAICompatible({ name: "deepseek" })`)
 * — the dedicated @ai-sdk/deepseek SDK silently dropped image parts. Everything
 * else falls back to the OpenAI-compatible path, so adding a new provider is
 * purely a catalog concern — no dispatch code changes.
 */

export type ProviderSdk = "deepseek" | "anthropic" | "openai";

export interface ProviderRoute {
  key: string;
  /** Which AI SDK factory constructs the model. */
  sdk: ProviderSdk;
}

const CURATED_ROUTES: ProviderRoute[] = [
  { key: "deepseek", sdk: "deepseek" },
  { key: "anthropic", sdk: "anthropic" },
];

const routeByKey = new Map(CURATED_ROUTES.map((r) => [r.key, r]));

/**
 * Resolve how to call a provider's models. Unknown providers default to the
 * OpenAI-compatible path; the catalog supplies baseURL + envKey from models.dev
 * for those.
 */
export function resolveProviderRoute(key: string): ProviderRoute {
  return routeByKey.get(key) ?? { key, sdk: "openai" };
}
