/**
 * Worker model resolution — the "auxiliary" tier behind the chat agent.
 *
 * The chat's main model is user-selected (and user-visible). But several
 * internal calls run a separate, cheaper model: housekeeping tag extraction +
 * slice marking, recall search, belief evolution, and background loops. These
 * used to be hardcoded to `deepseek(...)`, which broke the moment a user
 * configured a non-DeepSeek provider. This module resolves the worker from the
 * user's config:
 *
 *   manual pin  → the explicitly chosen model (config.worker.mode = "manual")
 *   auto        → a lightweight model from the SAME provider as the main model
 *                 (curated for known providers; non-thinking + smallest context
 *                 from the models.dev catalog otherwise)
 *   fallback    → the main model itself (same provider, always correct)
 *
 * Also provides `workerProviderOptions`: the "thinking disabled" provider
 * options shape per SDK, since worker calls are always cheap structured tasks.
 */
import { getModel, getDefaultModelId, ALL_MODELS, type ModelConfig } from "./registry";
import { resolveAvailableModels } from "./catalog";
import { loadUserConfig } from "@/lib/config/loader";
import type { ProviderSdk } from "./providers";

/** Curated cheap model per provider (only for providers with curated registry entries). */
const WORKER_IDS: Record<string, string> = {
  deepseek: "deepseek-v4-flash",
  anthropic: "claude-haiku-4-5",
};

/** Resolve a model id → full config, from the curated registry or the dynamic catalog. */
export async function resolveModelById(
  id: string,
): Promise<ModelConfig | undefined> {
  const curated = getModel(id);
  if (curated) return curated;
  const available = await resolveAvailableModels();
  return available.find((m) => m.id === id);
}

/** Resolve the configured main model (config.model.provider) to a full ModelConfig. */
export async function resolveMainModelFromConfig(): Promise<ModelConfig> {
  const config = await loadUserConfig();
  const main = await resolveModelById(config.model.provider);
  if (main) return main;
  const fallbackId = getDefaultModelId();
  return getModel(fallbackId) ?? ALL_MODELS[0];
}

/**
 * Resolve the worker model for a turn. When `main` is omitted, it is derived
 * from the user config. Resolution order: manual pin → same-provider
 * lightweight → the main model itself.
 */
export async function resolveWorkerModel(
  main?: ModelConfig,
): Promise<ModelConfig> {
  const mainModel = main ?? (await resolveMainModelFromConfig());
  const config = await loadUserConfig();

  // Manual pin — an explicit user choice wins over every heuristic.
  if (config.worker?.mode === "manual" && config.worker.provider) {
    const pinned = await resolveModelById(config.worker.provider);
    if (pinned && process.env[pinned.envKey]) return pinned;
  }

  // Auto — same-provider lightweight, curated first, catalog heuristic second.
  const curatedId = WORKER_IDS[mainModel.provider];
  if (curatedId) {
    const curated = getModel(curatedId);
    if (curated && process.env[curated.envKey]) return curated;
  }
  const available = await resolveAvailableModels();
  const sameProvider = available.filter((m) => m.provider === mainModel.provider);
  const light = sameProvider
    .filter((m) => !m.capabilities.thinking)
    .sort((a, b) => a.capabilities.maxTokens - b.capabilities.maxTokens)[0];
  if (light) return light;

  return mainModel;
}

// ─── Thinking-disabled provider options (worker runs structured tasks) ────

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}
type WorkerProviderOptions = Record<string, JsonObject>;

/**
 * Provider options with thinking/reasoning OFF, shaped per SDK. Worker calls
 * (tag extraction, marking, recall, evolution, loops) are always cheap
 * structured tasks — never long-form reasoning.
 */
export function workerProviderOptions(
  sdk: ProviderSdk | undefined,
): WorkerProviderOptions | undefined {
  switch (sdk) {
    case "anthropic":
      return { anthropic: { thinking: { type: "disabled" } } };
    case "openai":
      return { openai: { reasoningEffort: "minimal" } };
    default:
      // DeepSeek (default) — V4 defaults to thinking ENABLED, so "off" explicit.
      return { deepseek: { thinking: { type: "disabled" } } };
  }
}
