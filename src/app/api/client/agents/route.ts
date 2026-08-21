/**
 * GET /api/client/agents — local agent CLI detection for the settings UI
 * (client mode only; 404 in cloud mode).
 *
 * Reports which bridge agent CLIs (claude / codex / kimi) are installed on
 * this machine's PATH, with resolved path and version when the probes
 * succeed. Read-only, no secrets — the answer describes the operator's own
 * machine. Probes are timeout-bounded (src/lib/client-detect.ts) so a
 * hanging binary can never wedge this endpoint.
 */

import { isClientMode } from "@/lib/mode";
import { detectLocalAgents } from "@/lib/client-detect";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!isClientMode()) {
    return Response.json(
      { error: "Client agent detection is only available in client mode." },
      { status: 404 },
    );
  }

  const agents = await detectLocalAgents();
  return Response.json({ agents });
}
