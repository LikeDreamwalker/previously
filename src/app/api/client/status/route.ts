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
import { getPreviouslyHome, readClientConfig } from "@/lib/client-config";
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

  // The local agent engine is active via env (PREVIOUSLY_BRAIN=bridge) OR
  // config.json (brain.type === "bridge") — report both honestly.
  const clientConfig = await readClientConfig().catch(() => null);
  const bridgeBrain = isBridgeBrainActive(clientConfig?.brain);
  const models = await resolveAvailableModels();

  return Response.json({
    mode: getMode(),
    version: APP_VERSION,
    memoryRoot,
    home: getPreviouslyHome(),
    bridge: {
      /** The operator-controlled bridge command line. */
      cmd: getBridgeCommand(),
      /** The default bridged agent — only when the local agent engine is active. */
      agent: bridgeBrain ? getBridgeAgent(clientConfig?.brain) : null,
      /** Whether the local agent engine is active (env or config brain). */
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
