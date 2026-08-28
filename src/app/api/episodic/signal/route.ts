/**
 * POST /api/episodic/signal — mechanical interaction signals from the client
 * (v1.0 design §2.6, extended to the user's own hands on the UI).
 *
 * The interrupt signal cannot ride a chat request — there IS no request when
 * the user hits stop — so the client POSTs it here fire-and-forget
 * (fetch keepalive). The signal is attributed to the active slice and lands
 * in the fitness store + the slice's agent.md through the same double-write
 * path as the recall rework signals (logInteractionSignal). The regenerate
 * signal is NOT accepted here: it rides its own chat turn (the regenerate
 * body flag) and is recorded inside housekeeping — accepting it here too
 * would double-record.
 *
 * Instrumentation, never user-facing: the response is best-effort and a
 * missing/active-less slice simply drops the signal.
 */
import { z } from "zod";
import { guardRequest } from "@/lib/security/origin-guard";
import { tryLoadTodaySlice } from "@/lib/episodic/manager";
import { logInteractionSignal } from "@/lib/episodic/rework-signal";

const signalRequestSchema = z.object({
  type: z.enum(["interaction_interrupt"]),
  detail: z.string().max(500).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  try {
    const parsed = signalRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "Invalid signal" }, { status: 400 });
    }
    const slice = await tryLoadTodaySlice();
    if (!slice || slice.status !== "active") {
      // No live slice to attribute the reaction to — drop it quietly.
      return Response.json({ ok: true, recorded: false });
    }
    await logInteractionSignal(
      parsed.data.type,
      slice.slice_id,
      parsed.data.detail ?? "user interrupted the turn mid-stream",
    );
    return Response.json({ ok: true, recorded: true });
  } catch (error) {
    // Instrumentation must never take the client down — log and 500 plainly.
    console.error(
      "[signal] POST /api/episodic/signal:",
      error instanceof Error ? error.message : error,
    );
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
