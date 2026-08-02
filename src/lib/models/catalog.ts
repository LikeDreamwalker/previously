/**
 * Runtime model catalog — the available models for the deployment, resolved
 * from each configured provider's live API.
 *
 * No community catalog: the list is built by calling the model-list endpoint
 * of every provider whose API key is set (DeepSeek `/models`, Anthropic
 * `/v1/models`, OpenAI-compatible `/models`, Google's native list). Live ids
 * are normalized (legacy → current names), enriched with curated metadata for
 * known ids, and given sensible provider defaults when unknown. A provider
 * whose list call fails falls back to its curated entries so it stays usable
 * offline.
 *
 * The result is cached briefly; env changes take effect after TTL.
 */

import type { ModelConfig } from "./registry";
import {
  ALL_MODELS,
  getModelOverrides,
  getAvailableModels,
  resolveModelId,
} from "./registry";
import type { ProviderSdk } from "./providers";

const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

let cache: { at: number; models: ModelConfig[] } | null = null;

// ─── Live list fetching ───────────────────────────────────────────────────

interface LiveModel {
  id: string;
  name?: string;
}

/** Fetch a JSON body with a timeout; null on any failure (never throws). */
async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Heuristic drop of obvious non-chat ids from OpenAI-compatible `/models`
 * lists (embeddings, image/audio/tts, moderation, rerank, ...). Providers
 * whose lists are clean (DeepSeek, Anthropic) don't need it.
 */
function isChatModelId(id: string): boolean {
  return !/(embedding|\bembed\b|moderation|whisper|\btts\b|dall-?e|\bimage\b|audio|rerank|transcri|translate|summariz|classificat|ocr)/i.test(
    id,
  );
}

/** OpenAI-compatible `GET {baseURL}/models`. */
function openAiCompatList(
  baseURL: string,
): (key: string) => Promise<LiveModel[]> {
  return async (key) => {
    const json = await fetchJson(`${baseURL}/models`, {
      Authorization: `Bearer ${key}`,
    });
    const data = (json as { data?: Array<{ id?: unknown; name?: unknown }> } | null)?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((d) => ({
        id: typeof d.id === "string" ? d.id : "",
        name: typeof d.name === "string" ? d.name : undefined,
      }))
      .filter((m) => m.id && isChatModelId(m.id));
  };
}

/** Anthropic `GET /v1/models` (x-api-key auth). */
async function anthropicList(key: string): Promise<LiveModel[]> {
  const json = await fetchJson("https://api.anthropic.com/v1/models", {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  });
  const data = (json as { data?: Array<{ id?: unknown; display_name?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => ({
      id: typeof d.id === "string" ? d.id : "",
      name: typeof d.display_name === "string" ? d.display_name : undefined,
    }))
    .filter((m) => m.id);
}

/** Google native `GET /v1beta/models` (query-param auth). */
async function googleList(key: string): Promise<LiveModel[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const json = await fetchJson(url);
  const models = (json as
    | {
        models?: Array<{
          name?: unknown;
          displayName?: unknown;
          supportedGenerationMethods?: unknown;
        }>;
      }
    | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent"),
    )
    .map((m) => ({
      id: typeof m.name === "string" ? m.name.replace(/^models\//, "") : "",
      name: typeof m.displayName === "string" ? m.displayName : undefined,
    }))
    .filter((m) => m.id);
}

// ─── Provider sources ─────────────────────────────────────────────────────

interface ModelDefaults {
  thinking: boolean;
  vision: boolean;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}

interface ProviderSource {
  /** Provider key — the `provider` field on ModelConfig and route lookups. */
  key: string;
  providerName: string;
  /** Candidate env vars for the API key (first configured one wins). */
  envKeys: string[];
  sdk: ProviderSdk;
  /** OpenAI-compatible base URL; set on ModelConfig for openai-sdk dispatch. */
  openaiBaseURL?: string;
  list: (key: string) => Promise<LiveModel[]>;
  /** Defaults for live ids not present in the curated registry. */
  defaults: ModelDefaults;
}

const SOURCES: ProviderSource[] = [
  {
    key: "deepseek",
    providerName: "DeepSeek",
    envKeys: ["DEEPSEEK_API_KEY"],
    sdk: "deepseek",
    openaiBaseURL: "https://api.deepseek.com",
    list: openAiCompatList("https://api.deepseek.com"),
    defaults: { thinking: true, vision: false, maxTokens: 393216, effort: "low" },
  },
  {
    key: "anthropic",
    providerName: "Anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    sdk: "anthropic",
    list: anthropicList,
    defaults: { thinking: true, vision: true, maxTokens: 200000, effort: "medium" },
  },
  {
    key: "openai",
    providerName: "OpenAI",
    envKeys: ["OPENAI_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://api.openai.com/v1",
    list: openAiCompatList("https://api.openai.com/v1"),
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
  {
    key: "moonshotai",
    providerName: "Moonshot AI",
    envKeys: ["MOONSHOT_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://api.moonshot.cn/v1",
    list: openAiCompatList("https://api.moonshot.cn/v1"),
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
  {
    key: "alibaba",
    providerName: "Alibaba",
    envKeys: ["DASHSCOPE_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    list: openAiCompatList("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
  {
    key: "google",
    providerName: "Google",
    envKeys: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    list: googleList,
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
  {
    key: "mistral",
    providerName: "Mistral",
    envKeys: ["MISTRAL_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://api.mistral.ai/v1",
    list: openAiCompatList("https://api.mistral.ai/v1"),
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
  {
    key: "xai",
    providerName: "xAI",
    envKeys: ["XAI_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://api.x.ai/v1",
    list: openAiCompatList("https://api.x.ai/v1"),
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
  {
    key: "groq",
    providerName: "Groq",
    envKeys: ["GROQ_API_KEY"],
    sdk: "openai",
    openaiBaseURL: "https://api.groq.com/openai/v1",
    list: openAiCompatList("https://api.groq.com/openai/v1"),
    defaults: { thinking: false, vision: false, maxTokens: 200000, effort: "low" },
  },
];

// ─── Config building ──────────────────────────────────────────────────────

/** First configured candidate env var for a provider, or undefined. */
function firstConfiguredKey(envKeys: string[]): string | undefined {
  return envKeys.find((k) => !!process.env[k]);
}

function buildConfig(
  id: string,
  name: string | undefined,
  source: ProviderSource,
  envKey: string,
): ModelConfig {
  const normalized = resolveModelId(id);
  const curated = ALL_MODELS.find((m) => m.id === normalized);
  if (curated) return curated;

  const override = getModelOverrides(normalized);
  return {
    id: normalized,
    name: name ?? normalized,
    provider: source.key,
    providerName: source.providerName,
    sdk: source.sdk,
    envKey,
    baseURL: source.openaiBaseURL,
    capabilities: {
      thinking: source.defaults.thinking,
      vision: source.defaults.vision,
      maxTokens: source.defaults.maxTokens,
    },
    defaultThinking: source.defaults.thinking,
    defaultEffort: override?.defaultEffort ?? source.defaults.effort,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Reset the module-level cache (used by tests). */
export function __resetCatalogCache(): void {
  cache = null;
}

/**
 * Resolve the available models for the current deployment. Server-only
 * (reads process.env). For every provider whose API key is configured, pulls
 * the live model list; unknown ids get provider defaults; a failed list falls
 * back to that provider's curated entries.
 */
export async function resolveAvailableModels(): Promise<ModelConfig[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.models;

  const configured = SOURCES.filter((s) => firstConfiguredKey(s.envKeys));
  const groups = await Promise.all(
    configured.map(async (source) => {
      const envKey = firstConfiguredKey(source.envKeys) as string;
      let live: LiveModel[] = [];
      try {
        live = await source.list(envKey);
      } catch {
        live = [];
      }
      if (live.length > 0) {
        return live.map((m) => buildConfig(m.id, m.name, source, envKey));
      }
      console.warn(
        `[catalog] ${source.key}: live model list unavailable — using curated entries`,
      );
      return getAvailableModels().filter((m) => m.provider === source.key);
    }),
  );

  // Dedupe by id — legacy + current names normalize to the same id.
  const seen = new Set<string>();
  const models: ModelConfig[] = [];
  for (const m of groups.flat()) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }

  cache = { at: now, models };
  return models;
}
