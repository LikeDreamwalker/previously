/**
 * Loop step functions — full Node.js, retried automatically on failure.
 *
 * Kept in a SEPARATE module from the workflow so their Node-dependent imports
 * (gray-matter + fs via the store) never enter the deterministic workflow
 * sandbox. The workflow imports these `"use step"` functions by reference; the
 * loader compiles them into the step bundle, not the workflow bundle.
 *
 * The reasoning itself no longer lives here: the workflow body runs the shared
 * WorkflowAgent (src/app/api/agent/), and per-increment checkpointing happens
 * inside the agent's `loopReport` tool executor (read-append-write on the loop
 * file + a data-loop progress chunk). These two steps only own the run's
 * bookends:
 *   - initLoop     — create the record up front ("running", no steps) so the
 *     human sees the loop immediately, emit the first progress chunk, and
 *     resolve the serializable tool context (env is readable here, not in the
 *     workflow body).
 *   - finalizeLoop — stamp the final status onto the record, emit the closing
 *     data-loop chunk (done: true), and close the run's writable.
 */
import { type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import type {
  LoopInput,
  LoopRun,
  LoopStatus,
  LoopStep,
} from "@/lib/loops/types";
import { readLoopRun, serializeLoop, writeLoopFile } from "@/lib/loops/store";
import type { ToolContext } from "@/app/api/agent/tool-executors";

import { resolveDataSource } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";

const DATA_SOURCE = resolveDataSource();
const USE_GITHUB = DATA_SOURCE === "github";
const USE_DEMO = DATA_SOURCE === "demo";

/** Serialize the run state and write it to the loop's markdown file. */
async function writeRecord(
  input: LoopInput,
  steps: LoopStep[],
  status: LoopStatus,
  lastError: string
): Promise<void> {
  const run: LoopRun = {
    loopId: input.loopId,
    goal: input.goal,
    status,
    startedAt: input.startedAt,
    updatedAt: new Date().toISOString(),
    sliceOrigin: input.sliceOrigin,
    tags: input.tags,
    iterations: steps.length,
    maxIterations: input.maxIterations,
    lastError,
    steps,
  };
  await writeLoopFile(input.filePath, serializeLoop(run));
}

/**
 * Emit a progress chunk to the run's durable writable so any client connected
 * via GET /api/loops/{runId}/stream can follow along. Best-effort — a stream
 * failure must never crash the loop, because the memory-truth write already
 * committed.
 */
async function writeProgressChunk(
  input: LoopInput,
  steps: LoopStep[],
  status: LoopStatus,
  isFinal: boolean
): Promise<void> {
  try {
    const writable = getWritable<UIMessageChunk>();
    const writer = writable.getWriter();
    await writer.write({
      type: "data-loop",
      id: `loop-${input.loopId}`,
      data: {
        loopId: input.loopId,
        goal: input.goal,
        status,
        iteration: steps.length,
        latestStep: steps.length > 0 ? steps[steps.length - 1] : null,
        done: isFinal,
      },
    } as UIMessageChunk);
    writer.releaseLock();
    if (isFinal) {
      await writable.close();
    }
  } catch (err) {
    console.warn(
      `[Loop] stream write failed (loop=${input.loopId}):`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Create the record up front so the human sees "running" immediately, and
 * resolve the memory tools' serializable context from the environment.
 */
export async function initLoop(
  input: LoopInput
): Promise<{ toolContext: ToolContext }> {
  "use step";

  await writeRecord(input, [], "running", "");
  await writeProgressChunk(input, [], "running", false);

  const { owner, repo } = getRepoConfig();
  return {
    toolContext: {
      repo,
      owner,
      useGithub: USE_GITHUB,
      useDemo: USE_DEMO,
      sliceId: input.sliceOrigin ?? "",
      recentTurns: [],
    },
  };
}

/**
 * Stamp the final status onto the loop record (re-reading the steps the
 * loopReport executor accumulated in the file) and settle the stream.
 */
export async function finalizeLoop(
  input: LoopInput,
  status: LoopStatus,
  lastError: string
): Promise<{ iterations: number }> {
  "use step";

  const existing = await readLoopRun(input.filePath);
  const steps = existing?.steps ?? [];

  await writeRecord(input, steps, status, lastError);
  await writeProgressChunk(input, steps, status, true);

  return { iterations: steps.length };
}
