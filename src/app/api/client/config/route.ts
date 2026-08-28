/**
 * GET/POST /api/client/config — read/update PREVIOUSLY_HOME/config.json
 * (client mode only; 404 in cloud mode).
 *
 * The kernel manages exactly four fields of the client-owned file:
 * `executionBackend` (string | null), `brain` ({ type: "api-key", env,
 * model? } | { type: "bridge", agent }), `agents` (per-agent bridge
 * defaults: { model?, effort? } — effort for claude/codex only), and `byok`
 * (the user's own API key: { provider, apiKey, baseUrl?, model }). All other
 * fields pass through untouched. POST is same-origin guarded like every
 * mutation endpoint (src/lib/security/origin-guard.ts). Validation and write
 * failures are reported honestly — never a fake "saved". A successful POST
 * resets the model-catalog cache so a freshly saved BYOK model shows up in
 * the selector immediately.
 */

import { isClientMode } from "@/lib/mode";
import { guardRequest } from "@/lib/security/origin-guard";
import {
  ClientConfigError,
  readClientConfig,
  writeClientConfig,
  type ClientConfigPatch,
} from "@/lib/client-config";
import { __resetCatalogCache } from "@/lib/models/catalog";

export const dynamic = "force-dynamic";

function notInClientMode(): Response {
  return Response.json(
    { error: "Client config is only available in client mode." },
    { status: 404 },
  );
}

export async function GET(): Promise<Response> {
  if (!isClientMode()) return notInClientMode();
  try {
    const snapshot = await readClientConfig();
    return Response.json(snapshot);
  } catch (e) {
    const status = e instanceof ClientConfigError ? e.status : 500;
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  if (!isClientMode()) return notInClientMode();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { error: "Body must be a JSON object with optional executionBackend / brain / agents / byok fields" },
      { status: 400 },
    );
  }

  const patch: ClientConfigPatch = {};
  const input = body as Record<string, unknown>;
  if ("executionBackend" in input) {
    patch.executionBackend = input.executionBackend as string | null;
  }
  if ("brain" in input) {
    patch.brain = input.brain as ClientConfigPatch["brain"];
  }
  if ("agents" in input) {
    patch.agents = input.agents as ClientConfigPatch["agents"];
  }
  if ("byok" in input) {
    patch.byok = input.byok as ClientConfigPatch["byok"];
  }
  if (
    !("executionBackend" in input) &&
    !("brain" in input) &&
    !("agents" in input) &&
    !("byok" in input)
  ) {
    return Response.json(
      { error: "Nothing to update — provide executionBackend, brain, agents and/or byok" },
      { status: 400 },
    );
  }

  try {
    const snapshot = await writeClientConfig(patch);
    // A fresh byok section must show up in the model selector immediately —
    // the catalog otherwise caches the available-models list for 30 min.
    __resetCatalogCache();
    return Response.json(snapshot);
  } catch (e) {
    const status = e instanceof ClientConfigError ? e.status : 500;
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
