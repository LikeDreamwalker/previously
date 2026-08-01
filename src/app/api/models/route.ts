/**
 * GET /api/models — the available models for the current deployment.
 *
 * Server-side only: availability depends on which provider API keys are set in
 * the environment, which the client can never see. Returns a client-safe,
 * shell-sized shape (no secrets). DeepSeek's list is refreshed at runtime
 * (see @/lib/models/catalog), Anthropic's is curated.
 */

import { resolveAvailableModels } from "@/lib/models/catalog";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const models = await resolveAvailableModels();

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
