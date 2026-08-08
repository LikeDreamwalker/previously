/**
 * Durable evolution workflow — runs on slice close (v0.7) and explicit user
 * trigger, instead of on every turn.
 *
 * It reads a slice's previously.md + agent.md (the slice is the one that just
 * closed when sliceId is given, else the current active one), runs the
 * Previously Agent (worker model) to update the card, applies it, and streams
 * progress back.
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
  /** Target slice to evolve — a just-closed slice, or absent for the active one. */
  sliceId?: string;
  /** Previously Agent signal: slice_closed | user_correction | ... (default new_observation). */
  signal?: string;
}

export async function evolutionWorkflow(input: EvolutionInput): Promise<void> {
  "use workflow";

  const context = await readEvolutionContext(input);
  await finalizeEvolution(input, context);
}
