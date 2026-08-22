/**
 * Worker model resolution — the "auxiliary" tier behind the chat agent.
 *
 * The chat's main model is user-selected (and user-visible). Internal calls
 * historically ran on a separate, cheaper worker model hardcoded to
 * `deepseek(...)`, which broke the moment a user configured a non-DeepSeek
 * provider. This module resolves the worker from the user's config:
 *
 *   manual pin  → the explicitly chosen model (config.worker.mode = "manual")
 *   auto        → a lightweight model from the SAME provider as the main model
 *                 (curated for known providers; non-thinking + smallest context
 *                 from the models.dev catalog otherwise)
 *   fallback    → the main model itself (same provider, always correct)
 *
 * v0.9: every sub-agent (evolution, recall, housekeeping) moved to the MAIN
 * model via the unified sub-agent runner (src/lib/agents/sub-agent-runner.ts)
 * with thinking ON at a low effort, so `resolveWorkerModel` currently has NO
 * production caller — it is retained as a config-level escape hatch. The
 * settings-UI worker pin was removed with v0.9 (dead setting); the
 * `config.worker` field itself stays so a manual pin can still be set by
 * hand-editing memory/user/config.json. The old `workerProviderOptions`
 * ("thinking disabled" provider options) was removed with its last call site;
 * thinking-effort mapping now lives in effort-injector.ts
 * (`normalizeReasoningEffort`).
 *
 * Single brain switch (client mode, PREVIOUSLY_BRAIN=bridge): when the main
 * model runs on the local subscription bridge, the sub-agents automatically
 * run on the SAME bridge model — the unified runner resolves the turn's main
 * model, which IS the bridge model. `resolveWorkerModel` below still encodes
 * that invariant for its remaining callers (tests / the escape hatch): a
 * manual pin wins when set, otherwise a bridge main model is returned as-is.
 */
import { getModel, getDefaultModelId, ALL_MODELS, type ModelConfig } from "./registry";
import { resolveAvailableModels } from "./catalog";
import { loadUserConfig } from "@/lib/config/loader";

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
 * from the user config. Resolution order: manual pin → bridge main model as-is
 * (single brain switch) → same-provider lightweight → the main model itself.
 */
export async function resolveWorkerModel(
  main?: ModelConfig,
): Promise<ModelConfig> {
  const mainModel = main ?? (await resolveMainModelFromConfig());
  const config = await loadUserConfig();

  // Manual pin — an explicit user choice wins over every heuristic, bridge
  // mode included (the escape hatch for a separate worker configuration).
  if (config.worker?.mode === "manual" && config.worker.provider) {
    const pinned = await resolveModelById(config.worker.provider);
    if (pinned && process.env[pinned.envKey]) return pinned;
  }

  // Single brain switch: when the main model runs on the subscription bridge
  // (sdk "bridge"), the worker is the SAME bridge model — there is no separate
  // worker configuration in bridge mode. Honest cost: every worker call (tag
  // extraction, recall, belief evolution) is a minute-scale CLI subprocess
  // billed to the user's subscription quota; there is no cheap tier here.
  if (mainModel.sdk === "bridge") return mainModel;

  // Auto — same-provider lightweight, curated first, catalog heuristic second.
  const curatedId = WORKER_IDS[mainModel.provider];
  if (curatedId) {
    const curated = getModel(curatedId);
    if (curated && process.env[curated.envKey]) return curated;
  }
  const available = await resolveAvailableModels();
  const sameProvider = available.filter(
    (m) => m.provider === mainModel.provider,
  );
  const light = sameProvider
    .filter((m) => !m.capabilities.thinking)
    .sort((a, b) => a.capabilities.maxTokens - b.capabilities.maxTokens)[0];
  if (light) return light;

  return mainModel;
}
