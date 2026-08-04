/**
 * GET /api/chat/<runId>/status — durable turn-status lookup.
 *
 * Layer 2 of v0.6: a client that holds only a workflow runId (persisted by
 * WorkflowChatTransport) can learn its turn's lifecycle status here, even after
 * the run itself has been evicted from memory and the reconnect stream 404s.
 *
 * Resolution: the route layer registers `memory/sessions/.runs/<runId>.json`
 * → turnId when the turn starts; finalizeTurn writes the terminal state to
 * `memory/sessions/<turnId>.json`. This endpoint walks that chain and returns
 * the TurnState as JSON. If the mapping or state is missing the run is either
 * unknown or its turn never settled — 404, and the client treats that as
 * "no status available".
 */
import { readTurnIdByRun, readTurnState } from "@/lib/sessions/store";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const { runId } = await params;

  const turnId = await readTurnIdByRun(runId);
  if (!turnId) {
    return new Response(JSON.stringify({ error: "Unknown run" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const state = await readTurnState(turnId);
  if (!state) {
    return new Response(JSON.stringify({ error: "Turn state not available" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, runId, state }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
