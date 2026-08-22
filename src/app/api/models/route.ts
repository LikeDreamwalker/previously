/**
 * GET /api/models — the available models for the current deployment.
 *
 * Server-side only: availability depends on which provider API keys are set in
 * the environment, which the client can never see. Returns a client-safe,
 * shell-sized shape (no secrets). DeepSeek's list is refreshed at runtime
 * (see @/lib/models/catalog), Anthropic's is curated.
 */

import { resolveAvailableModels } from "@/lib/models/catalog";
import { demoModelLock } from "@/lib/demo/model-lock";

export const dynamic = "force-dynamic";

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
      }) => ({
        id,
        name,
        provider,
        providerName,
        supportsThinking: capabilities.thinking,
        supportsVision: capabilities.vision,
        maxTokens: capabilities.maxTokens,
        defaultThinking,
        defaultEffort,
      }),
    ),
  });
}
