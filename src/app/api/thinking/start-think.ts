/**
 * startThink — the single entry point that fires a durable thinking-agent run.
 *
 * Mirrors startLoop (src/app/api/loops/start-loop.ts): the thinkDeep tool
 * executor calls this in-process; it builds the serializable ThinkInput (the
 * executor already minted the thinkId / stamped the start time) and hands the
 * run off to `start()` fire-and-forget. Returns immediately — the thinking
 * agent keeps working after the dispatching turn's step settles, and its report
 * is written to disk for the main turn to poll.
 */
import { start } from "workflow/api";
import { thinkWorkflow } from "./think-workflow";
import type { ThinkInput } from "@/lib/thinking/types";

export interface StartedThink {
  thinkId: string;
  runId: string;
}

export async function startThink(input: ThinkInput): Promise<StartedThink> {
  const run = await start(thinkWorkflow, [input]);
  return { thinkId: input.thinkId, runId: run.runId };
}
