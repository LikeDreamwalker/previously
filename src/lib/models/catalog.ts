/**
 * Runtime model catalog — resolves the full available-model list for the
 * selector, combining the curated metadata (./registry) with dynamic discovery
 * where the provider supports it.
 *
 * Provider reality check:
 *   - DeepSeek (OpenAI-compatible) exposes `GET /models` → we refresh the id
 *     list at runtime so newly released models appear without a code deploy.
 *     The curated entry enriches display name / capabilities; unknown ids get
 *     a generated name. On any fetch failure we fall back to the curated list.
 *   - Anthropic has no list-models endpoint → curated only (see registry).
 *
 * The result is cached briefly; API-key rotation still takes effect on the
 * next page load after TTL.
 */

import type { ModelConfig } from "./registry";
import { ALL_MODELS, getAvailableModels } from "./registry";

const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; models: ModelConfig[] } | null = null;

/** GET /models on DeepSeek's OpenAI-compatible API. Returns [] on any failure. */
async function fetchDeepSeekModelIds(): Promise<string[]> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(DEEPSEEK_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (json.data ?? [])
      .map((d) => d.id)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** Prefer curated metadata for a known id; otherwise synthesize a name. */
function toDeepSeekModel(id: string): ModelConfig {
  const curated = ALL_MODELS.find(
    (m) => m.provider === "deepseek" && m.id === id,
  );
  if (curated) return curated;
  return {
    id,
    name: id
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    envKey: "DEEPSEEK_API_KEY",
    defaultThinking: false,
    defaultEffort: "low",
  };
}

/**
 * Resolve the available models for the current deployment.
 * Server-only (reads process.env). Returns curated Anthropic + dynamic DeepSeek
 * (falling back to curated DeepSeek when the API is unreachable).
 */
export async function resolveAvailableModels(): Promise<ModelConfig[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.models;

  const curated = getAvailableModels();
  let models = curated;

  // DeepSeek: try the live catalog; on success swap in dynamic ids.
  if (process.env.DEEPSEEK_API_KEY) {
    const ids = await fetchDeepSeekModelIds();
    if (ids.length > 0) {
      const dynamicDeepSeek = ids.map(toDeepSeekModel);
      models = [
        ...curated.filter((m) => m.provider !== "deepseek"),
        ...dynamicDeepSeek,
      ];
    }
  }

  cache = { at: now, models };
  return models;
}
