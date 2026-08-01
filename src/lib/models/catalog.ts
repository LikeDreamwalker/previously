/**
 * Runtime model catalog — resolves the full available-model list for the
 * selector.
 *
 * Primary source is models.dev (https://models.dev/api.json), a community-
 * maintained database that lists each provider's models with metadata and —
 * crucially — carries each provider's API key env-var name and baseURL. That
 * means ANY provider in the database whose key the deployer sets becomes
 * selectable with no code change; the OpenAI-compatible ones are called via
 * @ai-sdk/openai (see providers.ts / provider.ts).
 *
 * When models.dev is unreachable (timeout, offline, first run), we fall back
 * to the curated list in ./registry. Curated per-model overrides
 * (defaultThinking / defaultEffort) are applied on top of models.dev entries
 * for known ids.
 *
 * The result is cached briefly; env changes take effect after TTL.
 */

import type { ModelConfig } from "./registry";
import { getAvailableModels, getModelOverrides } from "./registry";
import { resolveProviderRoute } from "./providers";

const MODELS_DEV_URL = "https://models.dev/api.json";
// models.dev is a ~3.3MB JSON. On Vercel the fetch is fast, but a conservative
// timeout avoids spuriously falling back on a slow moment. Local dev with a
// slow route to models.dev still degrades gracefully to the curated list.
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

let cache: { at: number; models: ModelConfig[] } | null = null;

// ─── models.dev schema (subset we use) ─────────────────────────────────

interface ModelsDevModel {
  id?: string;
  name?: string;
  /** Thinking / extended reasoning support. */
  reasoning?: boolean;
  /** Multimodal (image/video) input support. */
  attachment?: boolean;
  limit?: { context?: number };
  modalities?: { input?: string[]; output?: string[] };
}

interface ModelsDevProvider {
  /** Candidate env-var names for the API key. */
  env?: string[];
  /** Base URL for the OpenAI-compatible endpoint. */
  api?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

// ─── Fetch + parse ─────────────────────────────────────────────────────

async function fetchModelsDev(): Promise<Record<string, ModelsDevProvider>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return {};
    const json = (await res.json()) as Record<string, unknown>;
    return json as Record<string, ModelsDevProvider>;
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Live model list from an OpenAI-compatible `GET {baseURL}/models`. Used to
 * reverse-filter the models.dev catalog to what the provider actually serves.
 * Returns an empty set on any failure (endpoint unsupported, auth, network) —
 * callers then keep the models.dev list for that provider.
 */
async function fetchProviderModelIds(
  baseURL: string,
  envKey: string,
): Promise<Set<string>> {
  const key = process.env[envKey];
  if (!key || !baseURL) return new Set();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return new Set();
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (json.data ?? [])
      .map((d) => d.id)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    return new Set(ids);
  } catch {
    return new Set();
  } finally {
    clearTimeout(timeout);
  }
}

/** First configured env name for a provider, or undefined if none set. */
function pickConfiguredEnv(env: string[] | undefined): string | undefined {
  if (!env || env.length === 0) return undefined;
  return env.find((e) => !!process.env[e]);
}

/**
 * Prune the catalog to the provider's live model list (reverse filter). Each
 * configured provider with an OpenAI-compatible /models endpoint is queried in
 * parallel; providers whose fetch fails (Anthropic has no endpoint, DeepSeek
 * if it doesn't serve /models, offline) keep their full models.dev list.
 */
async function pruneByLiveModels(
  models: ModelConfig[],
): Promise<ModelConfig[]> {
  const byProvider = new Map<string, ModelConfig[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  const pruned = await Promise.all(
    [...byProvider.values()].map(async (group) => {
      const first = group[0];
      if (!first.baseURL) return group;
      const liveIds = await fetchProviderModelIds(first.baseURL, first.envKey);
      if (liveIds.size === 0) return group;
      return group.filter((m) => liveIds.has(m.id));
    }),
  );
  return pruned.flat();
}

function isChatModel(model: ModelsDevModel): boolean {
  const output = model.modalities?.output;
  // Entries without a modalities field are treated as chat models; entries
  // with one must accept text output (drops embeddings / image-gen models).
  return !output || output.includes("text");
}

// ─── Build ─────────────────────────────────────────────────────────────

/** Reset the module-level cache (used by tests). */
export function __resetCatalogCache(): void {
  cache = null;
}

/**
 * Build ModelConfig entries from a models.dev payload for every provider whose
 * API key env var is set. Exported for testing; callers should use
 * `resolveAvailableModels`.
 */
export function buildFromModelsDev(
  data: Record<string, ModelsDevProvider>,
): ModelConfig[] {
  const models: ModelConfig[] = [];

  for (const [providerKey, provider] of Object.entries(data)) {
    const envKey = pickConfiguredEnv(provider.env);
    if (!envKey) continue; // this provider's key isn't configured — skip

    const route = resolveProviderRoute(providerKey);
    for (const [modelKey, raw] of Object.entries(provider.models ?? {})) {
      if (!isChatModel(raw)) continue;
      const id = raw.id ?? modelKey;
      if (!id) continue;

      const reasoning = raw.reasoning ?? true;
      const overrides = getModelOverrides(id);
      const context = raw.limit?.context;

      models.push({
        id,
        name: raw.name ?? id,
        provider: providerKey,
        providerName: provider.name ?? providerKey,
        sdk: route.sdk,
        envKey,
        // models.dev carries the provider's base URL. Dedicated SDKs ignore it;
        // OpenAI-compatible providers pass it to createOpenAI. It's also the
        // basis for the live /models reverse-filter below.
        baseURL: provider.api,
        capabilities: {
          thinking: reasoning,
          vision: raw.attachment ?? false,
          maxTokens: context ?? 200000,
        },
        defaultThinking: overrides?.defaultThinking ?? reasoning,
        defaultEffort: overrides?.defaultEffort ?? (reasoning ? "medium" : "low"),
      });
    }
  }

  return models;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Resolve the available models for the current deployment. Server-only
 * (reads process.env). Returns models.dev-derived entries for every provider
 * whose API key is configured, falling back to the curated list when
 * models.dev is unreachable.
 */
export async function resolveAvailableModels(): Promise<ModelConfig[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.models;

  const devData = await fetchModelsDev();
  const base =
    devData && Object.keys(devData).length > 0
      ? buildFromModelsDev(devData)
      : getAvailableModels();

  // Reverse filter: intersect with each provider's live /models list so the
  // selector shows what's actually callable (legacy/phantom ids drop out).
  // Only meaningful when models.dev provided the catalog (curated fallback has
  // no baseURL to query against).
  const models =
    devData && Object.keys(devData).length > 0
      ? await pruneByLiveModels(base)
      : base;

  cache = { at: now, models };
  return models;
}
