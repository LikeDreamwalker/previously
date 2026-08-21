/**
 * GET /api/client/status — client-mode deployment status for the settings UI.
 *
 * Registered in cloud mode too but answers 404 there — the status it reports
 * (PREVIOUSLY_HOME, bridge env, local memory root) only exists on a local
 * client instance. Read-only, no secrets: the bridge command and model list
 * are the operator's own local configuration.
 */

import { APP_VERSION } from "@/lib/version/constants";
import { getMode, isClientMode } from "@/lib/mode";
import {
  getBridgeAgent,
  isBridgeBrainActive,
} from "@/lib/models/registry";
import { getBridgeCommand, getBridgeTimeoutMs } from "@/lib/bridge";
import { resolveAvailableModels } from "@/lib/models/catalog";
import { getPreviouslyHome } from "@/lib/client-config";
import { getMemoryRoot } from "@/lib/whitelist";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!isClientMode()) {
    return Response.json(
      { error: "Client status is only available in client mode." },
      { status: 404 },
    );
  }

  // getMemoryRoot throws on a non-absolute MEMORY_ROOT — report that honestly
  // instead of taking the endpoint down.
  let memoryRoot: string | null;
  try {
    memoryRoot = getMemoryRoot();
  } catch (e) {
    memoryRoot = null;
    console.error("[client/status] MEMORY_ROOT misconfigured:", e);
  }

  const bridgeBrain = isBridgeBrainActive();
  const models = await resolveAvailableModels();

  return Response.json({
    mode: getMode(),
    version: APP_VERSION,
    memoryRoot,
    home: getPreviouslyHome(),
    bridge: {
      /** The operator-controlled bridge command line. */
      cmd: getBridgeCommand(),
      /** The bridged agent — only when the pure-subscription brain is active. */
      agent: bridgeBrain ? getBridgeAgent() : null,
      /** Whether PREVIOUSLY_BRAIN=bridge (no API-key main model). */
      active: bridgeBrain,
      timeoutMs: getBridgeTimeoutMs(),
    },
    models: models.map(
      ({ id, name, provider, providerName }) => ({
        id,
        name,
        provider,
        providerName,
      }),
    ),
  });
}
