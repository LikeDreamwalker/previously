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
import { resolveDataSource } from "@/lib/data-source/resolve";
import { createMixedStreamTransform } from "@/app/api/chat/mixed-stream-transform";

export async function POST(): Promise<Response> {
  const { owner, repo } = getRepoConfig();
  const dataSource = resolveDataSource();

  const run = await start(evolutionWorkflow, [
    {
      repo,
      owner,
      useGithub: dataSource === "github",
      useDemo: dataSource === "demo",
    },
  ]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createMixedStreamTransform()),
    headers: { "x-workflow-run-id": run.runId },
  });
}
