/**
 * Loop trigger endpoint — the "external door".
 *
 * A thin HTTP wrapper over startLoop(): POST a goal, get back the loop ids. Used
 * by UI actions, external/webhook/platform triggers, and tests. The agent does
 * NOT use this — it calls startLoop() in-process via its `startLoop` tool.
 *
 * Returns immediately; the loop keeps working after the caller disconnects and
 * writes its live progress to memory/loops/<date>/<loopId>.md.
 */
import { startLoop } from "./start-loop";
import { isDemo, DEPLOY_GUIDE_URL } from "@/lib/capabilities";

interface StartLoopBody {
  goal?: unknown;
  tags?: unknown;
  sliceId?: unknown;
  maxIterations?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: StartLoopBody;
  try {
    body = (await request.json()) as StartLoopBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) {
    return Response.json(
      { error: "`goal` (non-empty string) is required" },
      { status: 400 }
    );
  }

  // Demo mode: loops require a writable GitHub repo.
  if (isDemo()) {
    return Response.json(
      {
        error: "Background loops are not available in demo mode.",
        hint: "Deploy your own instance to unlock background loops.",
        guide: DEPLOY_GUIDE_URL,
      },
      { status: 403 }
    );
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string")
    : [];
  const sliceId = typeof body.sliceId === "string" ? body.sliceId : null;
  const maxIterations =
    typeof body.maxIterations === "number" ? body.maxIterations : undefined;

  try {
    const started = await startLoop({ goal, tags, sliceId, maxIterations });
    return Response.json({ ...started, status: "started" });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "failed to start loop" },
      { status: 500 }
    );
  }
}
