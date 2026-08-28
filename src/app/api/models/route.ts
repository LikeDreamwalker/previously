/**
 * GET /api/models — the available models for the current deployment.
 *
 * Server-side only: availability depends on which provider API keys are set in
 * the environment, which the client can never see. Returns a client-safe,
 * shell-sized shape (no secrets). DeepSeek's list is refreshed at runtime
 * (see @/lib/models/catalog), Anthropic's is curated.
 *
 * Bridge options (pure subscription mode) carry two extra fields: `hint`
 * (English informational copy; the selector renders its own localized hint
 * and treats this as a fallback for other API consumers) and `available`
 * (whether the agent CLI was detected on PATH — see src/lib/client-detect.ts).
 * BYOK options carry `hint` only. Detection results are cached module-side
 * with the same TTL as the model catalog, so a freshly installed CLI shows
 * up after the cache expires.
 */

import { resolveAvailableModels } from "@/lib/models/catalog";
import {
  bridgeAgentFromModelId,
  BRIDGE_AGENT_LABELS,
} from "@/lib/models/registry";
import { detectLocalAgents, type AgentDetection } from "@/lib/client-detect";
import { demoModelLock } from "@/lib/demo/model-lock";

export const dynamic = "force-dynamic";

/** Mirrors the catalog's 30-min TTL — PATH probes shouldn't run per request. */
const DETECTION_CACHE_TTL_MS = 30 * 60 * 1000;
let detectionCache: { at: number; agents: AgentDetection[] } | null = null;

async function detectAgentsCached(): Promise<AgentDetection[]> {
  const now = Date.now();
  if (detectionCache && now - detectionCache.at < DETECTION_CACHE_TTL_MS) {
    return detectionCache.agents;
  }
  const agents = await detectLocalAgents();
  detectionCache = { at: now, agents };
  return agents;
}

export async function GET(): Promise<Response> {
  let models = await resolveAvailableModels();

  // Demo mode: only the locked model is usable (startTurn enforces it), so the
  // selector shouldn't offer choices the server would ignore. If the locked
  // model isn't available in this deployment (e.g. no DeepSeek key), fall back
  // to the full list rather than an empty picker.
  const lock = demoModelLock();
  if (lock) {
    const locked = models.filter((m) => m.id === lock.model);
    if (locked.length > 0) models = locked;
  }

  // Probe the local agent CLIs only when bridge entries are actually listed.
  const detected = models.some((m) => m.provider === "bridge")
    ? await detectAgentsCached()
    : [];
  const foundByAgent = new Map(detected.map((d) => [d.name, d.found]));

  return Response.json({
    models: models.map(
      ({
        id,
        name,
        provider,
        providerName,
        capabilities,
        defaultThinking,
        defaultEffort,
      }) => {
        const option = {
          id,
          name,
          provider,
          providerName,
          supportsThinking: capabilities.thinking,
          supportsVision: capabilities.vision,
          maxTokens: capabilities.maxTokens,
          defaultThinking,
          defaultEffort,
        };
        if (provider === "byok") {
          return {
            ...option,
            hint: "Uses your own API key (recommended) — a direct API connection.",
          };
        }
        // A bridge option only reaches this list when the catalog registered
        // it (env or config.json brain — see resolveAvailableModels), so no
        // further engine gate is needed here.
        if (provider !== "bridge") return option;
        const agent = bridgeAgentFromModelId(id);
        return {
          ...option,
          hint:
            `Uses your local ${BRIDGE_AGENT_LABELS[agent]} subscription quota. ` +
            `For the best experience (streaming, tool use), prefer an API model.`,
          available: foundByAgent.get(agent) ?? false,
        };
      },
    ),
  });
}
