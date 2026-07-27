/**
 * POST /api/evolution — fire the self-evolution workflow.
 *
 * The client fires this in parallel with /api/chat on every user message.
 * The handler is intentionally thin: resolve the data source and start the
 * durable workflow run. No client body is needed — the evolution workflow
 * discovers the current slice and reads everything from files.
 */

import { start } from "workflow/api";
import { createUIMessageStreamResponse } from "ai";
import { evolutionWorkflow } from "./evolution-workflow";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource, isDemo } from "@/lib/data-source/resolve";
import { createMixedStreamTransform } from "@/app/api/chat/mixed-stream-transform";

export async function POST(): Promise<Response> {
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

  const run = await start(evolutionWorkflow, [
    {
      repo,
      owner,
      useGithub,
      useDemo,
    },
  ]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createMixedStreamTransform()),
    headers: { "x-workflow-run-id": run.runId },
  });
}
