/**
 * Durable loop workflow — the core of the "I come after you're done" engine.
 *
 * A loop takes a goal and works it with the SAME agent brain as the chat turn
 * (the shared WorkflowAgent in src/app/api/agent/), backed by a Vercel
 * Workflow run so it survives deploys and cold starts. The agent loop replaces
 * the old hand-written for-loop: each LLM call and each tool call is its own
 * durable step, and the agent checkpoints every increment via the `loopReport`
 * tool, whose executor persists to the loop's markdown file IMMEDIATELY — so
 * progress is visible in memory/ the moment it happens.
 *
 * This module is the deterministic controller: NO direct I/O and no Node.js
 * modules in its import graph. File writes live behind the `"use step"`
 * functions in ./steps and the tool executors; the stop conditions and status
 * derivation below are pure functions over serializable step results.
 *
 * Lives under src/app so the `withWorkflow` loader (which scans app/src/app by
 * default) picks up the `"use workflow"` directive.
 */
import { isStepCount, type StopCondition, type ToolSet } from "ai";
import { getWritable } from "workflow";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { createLoopAgent } from "@/app/api/agent/agent";
import { buildLoopToolsContext } from "@/app/api/agent/tools";
import type { LoopInput, LoopResult, LoopStatus } from "@/lib/loops/types";
import {
  detectNoProgressFromReports,
  type LoopReportLike,
} from "@/lib/loops/guards";
import { initLoop, finalizeLoop } from "./steps";

// ─── Pure helpers over serializable step results ─────────────────────────

interface LoopReportCall extends LoopReportLike {
  done: boolean;
}

/** All loopReport tool calls across the agent's steps, in order. */
function extractReports(steps: ReadonlyArray<unknown>): LoopReportCall[] {
  const reports: LoopReportCall[] = [];
  for (const step of steps) {
    const toolCalls = (step as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const c = tc as { toolName?: unknown; input?: unknown };
      if (c.toolName !== "loopReport") continue;
      const input = c.input as
        | { action?: unknown; result?: unknown; done?: unknown }
        | undefined;
      reports.push({
        action: typeof input?.action === "string" ? input.action : "",
        result: typeof input?.result === "string" ? input.result : "",
        done: input?.done === true,
      });
    }
  }
  return reports;
}

/**
 * The old per-iteration inner loop allowed up to 6 LLM steps per iteration
 * (`stopWhen: stepCountIs(6)` inside runLoopStep), so `maxIterations`
 * translates to an equivalent total LLM-step budget.
 */
function stepBudget(input: LoopInput): number {
  return input.maxIterations * 6;
}

/** Stop as soon as the agent reports the goal done. */
const loopReportedDone: StopCondition<ToolSet> = ({ steps }) =>
  extractReports(steps).some((r) => r.done);

/** Stall guard: the last 3 reports are near-duplicates (see guards.ts). */
const noProgress: StopCondition<ToolSet> = ({ steps }) =>
  detectNoProgressFromReports(extractReports(steps));

function deriveOutcome(
  steps: ReadonlyArray<unknown>,
  input: LoopInput
): { status: LoopStatus; lastError: string } {
  const reports = extractReports(steps);
  if (reports.some((r) => r.done)) {
    return { status: "completed", lastError: "" };
  }
  if (detectNoProgressFromReports(reports)) {
    return { status: "stuck", lastError: "No progress across the last 3 steps." };
  }
  if (steps.length >= stepBudget(input)) {
    return {
      status: "timeout",
      lastError: `Hit the step budget (${stepBudget(input)} LLM steps ≈ ${input.maxIterations} iterations).`,
    };
  }
  return {
    status: "stuck",
    lastError: "Agent stopped without reporting the goal as done.",
  };
}

function buildLoopPrompt(input: LoopInput): string {
  return `Goal: ${input.goal}

Work this goal to completion, step by step. Use the memory tools to do the actual work, and report every increment with the loopReport tool. When the goal is genuinely complete, report it with done=true and stop.`;
}

// ─── The workflow ────────────────────────────────────────────────────────

export async function loopWorkflow(input: LoopInput): Promise<LoopResult> {
  "use workflow";

  const { toolContext } = await initLoop(input);
  const agent = createLoopAgent({
    model: input.workerModel,
    toolsContext: buildLoopToolsContext(toolContext, {
      repo: toolContext.repo,
      owner: toolContext.owner,
      useGithub: toolContext.useGithub,
      loopId: input.loopId,
      goal: input.goal,
      filePath: input.filePath,
      startedAt: input.startedAt,
      sliceOrigin: input.sliceOrigin,
      tags: input.tags,
      maxIterations: input.maxIterations,
    }),
  });

  let status: LoopStatus;
  let lastError: string;
  try {
    const result = await agent.stream({
      prompt: buildLoopPrompt(input),
      writable: getWritable<ModelCallStreamPart>(),
      stopWhen: [loopReportedDone, noProgress, isStepCount(stepBudget(input))],
      // finalizeLoop owns the stream tail (final data-loop chunk + close).
      sendFinish: false,
      preventClose: true,
    });
    ({ status, lastError } = deriveOutcome(result.steps, input));
  } catch (err) {
    status = "failed";
    lastError = err instanceof Error ? err.message : "unknown error";
  }

  const { iterations } = await finalizeLoop(input, status, lastError);
  return { loopId: input.loopId, status, iterations };
}
