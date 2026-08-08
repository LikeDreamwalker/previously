/**
 * POST /api/evolution — fire the self-evolution workflow.
 *
 * The client fires this once per CLOSED slice (v0.7, via a "slice-closed"
 * stream signal) and on explicit user confirmation. The handler is thin:
 * resolve the data source and start the durable workflow run.
 *
 * Optional JSON body:
 *   { sliceId?, signal? } — when sliceId is given, evolution reads THAT slice
 *   (e.g. the slice that just closed) instead of the current active one;
 *   signal selects the Previously Agent mode (defaults to "new_observation").
 */

import { start } from "workflow/api";
import { createUIMessageStreamResponse } from "ai";
import { evolutionWorkflow } from "./evolution-workflow";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource, isDemo } from "@/lib/data-source/resolve";
import { resolveWorkerModel } from "@/lib/models/worker";
import { createMixedStreamTransform } from "@/app/api/chat/mixed-stream-transform";

export async function POST(request: Request): Promise<Response> {
  const { owner, repo } = getRepoConfig();
  const dataSource = resolveDataSource();
  const useGithub = dataSource === "github";
  const useDemo = isDemo(dataSource);

  // Demo mode: evolution requires a writable repo — skip the workflow entirely.
  // The client receives an empty stream with a skipped signal so it can handle
  // the case gracefully (no Previously Bar update, no wasted LLM call).
  if (useDemo) {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "data-evolution", id: "evolution-result", data: { running: false, changes: { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 }, hasChanges: false, skipped: true, reason: "demo" } })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish" })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Optional body: { sliceId, signal } — sliceId targets a specific (e.g. just
  // closed) slice; signal selects the Previously Agent mode.
  let sliceId: string | undefined;
  let signal: string | undefined;
  try {
    const body = (await request.json()) as { sliceId?: string; signal?: string };
    sliceId = typeof body.sliceId === "string" && body.sliceId ? body.sliceId : undefined;
    signal = typeof body.signal === "string" && body.signal ? body.signal : undefined;
  } catch {
    // No body (legacy trigger) — defaults apply.
  }

  const workerModel = await resolveWorkerModel();
  const run = await start(evolutionWorkflow, [
    {
      repo,
      owner,
      useGithub,
      useDemo,
      workerModel,
      sliceId,
      signal,
    },
  ]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createMixedStreamTransform()),
    headers: { "x-workflow-run-id": run.runId },
  });
}
