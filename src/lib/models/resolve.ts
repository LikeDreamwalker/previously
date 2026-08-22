/**
 * Model resolution helpers — model id → full ModelConfig, and the user's
 * configured main model.
 *
 * v0.9: the old worker tier is gone. Every sub-agent (evolution, recall,
 * housekeeping) runs on the MAIN model via the unified sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts) with thinking ON at a low effort —
 * there is no separate worker configuration, no manual pin, no escape hatch.
 * Single model: everything runs on the selected model.
 *
 * Single brain switch (client mode, PREVIOUSLY_BRAIN=bridge): when the main
 * model runs on the local subscription bridge, the sub-agents automatically
 * run on the SAME bridge model — the unified runner resolves the turn's main
 * model, which IS the bridge model.
 */
import { getModel, getDefaultModelId, ALL_MODELS, type ModelConfig } from "./registry";
import { resolveAvailableModels } from "./catalog";
import { loadUserConfig } from "@/lib/config/loader";

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
