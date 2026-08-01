/**
 * startLoop — the single entry point that fires a durable background loop.
 *
 * Both callers converge here:
 *   - the agent's `startLoop` tool (in the chat route) — the "internal door"
 *   - the POST /api/loops endpoint — the "external door" (UI button, webhooks,
 *     platform triggers, tests)
 *
 * All the domain-id / date-path / timestamp construction (which needs real
 * Date + a slug) lives here, in the route layer, so the deterministic workflow
 * never has to do it.
 */
import { start } from "workflow/api";
import { loopWorkflow } from "./loop-workflow";
import { resolveWorkerModel } from "@/lib/models/worker";
import type { LoopInput } from "@/lib/loops/types";
import type { ModelConfig } from "@/lib/models/registry";

const DEFAULT_MAX_ITERATIONS = 6;
const MAX_ALLOWED_ITERATIONS = 20;

export interface StartLoopArgs {
  /** What the loop should accomplish. */
  goal: string;
  /** Keyword tags, woven into strands (Phase 2). */
  tags?: string[];
  /** Originating time-slice id, for the attachment back-reference. */
  sliceId?: string | null;
  /** Optional override for the iteration cap (clamped to a hard ceiling). */
  maxIterations?: number;
  /** Resolved worker model; resolved from config when omitted. */
  workerModel?: ModelConfig;
}

export interface StartedLoop {
  loopId: string;
  runId: string;
  filePath: string;
}

function slugify(goal: string): string {
  const slug = goal
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "loop";
}

export async function startLoop(args: StartLoopArgs): Promise<StartedLoop> {
  const goal = args.goal.trim();
  if (!goal) {
    throw new Error("startLoop: `goal` must be a non-empty string");
  }

  const maxIterations =
    typeof args.maxIterations === "number" && args.maxIterations > 0
      ? Math.min(Math.floor(args.maxIterations), MAX_ALLOWED_ITERATIONS)
      : DEFAULT_MAX_ITERATIONS;

  const now = new Date();
  const loopId = `loop-${now.getTime()}-${slugify(goal)}`;
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const filePath = `memory/loops/${yyyy}/${mm}/${dd}/${loopId}.md`;

  const workerModel = args.workerModel ?? (await resolveWorkerModel());

  const input: LoopInput = {
    loopId,
    filePath,
    goal,
    tags: args.tags ?? [],
    sliceOrigin: args.sliceId ?? null,
    startedAt: now.toISOString(),
    maxIterations,
    workerModel,
  };

  const run = await start(loopWorkflow, [input]);
  return { loopId, runId: run.runId, filePath };
}
