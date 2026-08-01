/**
 * Durable evolution workflow — runs independently alongside the chat turn.
 *
 * Every turn, the client fires this workflow in parallel with the chat workflow.
 * It reads the current slice's previously.md + agent.md, runs the Previously
 * Agent (Pro model) to find mutations, applies them, and streams progress back.
 *
 * The chat workflow has NO knowledge of this workflow — they couple only
 * through the shared previously.md file on disk.
 */

import { readEvolutionContext, finalizeEvolution } from "./steps";
import type { ModelConfig } from "@/lib/models/registry";

export interface EvolutionInput {
  repo: string;
  owner: string;
  useGithub: boolean;
  useDemo: boolean;
  /** Resolved worker model for the belief review (see src/lib/models/worker.ts). */
  workerModel: ModelConfig;
}

export async function evolutionWorkflow(input: EvolutionInput): Promise<void> {
  "use workflow";

  const context = await readEvolutionContext(input);
  await finalizeEvolution(input, context);
}
