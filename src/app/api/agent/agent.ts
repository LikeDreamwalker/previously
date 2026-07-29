/**
 * Shared WorkflowAgent factories — the single agent brain behind both entry
 * workflows (chat turn and background loop).
 *
 * Constructed INSIDE the "use workflow" bodies (the official pattern): the
 * agent loop then runs in the Workflow runtime, so every LLM call and every
 * tool call is an individually durable, auto-retried step.
 *
 * Import-graph discipline: pure JS only (WorkflowAgent + deepseek provider
 * factory are object construction, no I/O). All Node I/O lives behind the
 * "use step" tool executors bound in ./tools.
 */

import { WorkflowAgent } from "@ai-sdk/workflow";
import { deepseek } from "@ai-sdk/deepseek";
import {
  chatTools,
  loopTools,
  type buildChatToolsContext,
  type buildLoopToolsContext,
} from "./tools";

export type ChatToolSet = typeof chatTools;
export type LoopToolSet = typeof loopTools;
export type ChatAgent = WorkflowAgent<ChatToolSet>;
export type LoopAgent = WorkflowAgent<LoopToolSet>;

/**
 * Chat agent. The per-turn dynamic system prompt (identity + intent + episodic
 * timeline + memory nodes, assembled in the prepareGenerate step) is passed at
 * call time via `stream({ system })`, overriding these base instructions.
 * Tools declare a `contextSchema`, so the serializable per-turn context is
 * required here at construction (build it with `buildChatToolsContext`).
 */
export function createChatAgent(opts: {
  modelId: string;
  thinking: boolean;
  reasoningEffort: "low" | "medium" | "high";
  toolsContext: ReturnType<typeof buildChatToolsContext>;
  /** Safety cap to keep single LLM step under Vercel's 5‑minute limit. */
  maxOutputTokens?: number;
}): ChatAgent {
  return new WorkflowAgent({
    model: deepseek(opts.modelId),
    maxOutputTokens: opts.maxOutputTokens,
    instructions:
      "You are the user's personal agent with layered episodic memory. Answer from the provided context; use the memory tools to recall details when needed.",
    tools: chatTools,
    toolsContext: opts.toolsContext,
    providerOptions: opts.thinking
      ? {
          deepseek: {
            thinking: { type: "enabled" as const },
            reasoningEffort: opts.reasoningEffort,
          },
        }
      : {
          // V4 models default to thinking ENABLED — "off" must be explicit.
          deepseek: { thinking: { type: "disabled" as const } },
        },
  });
}

/**
 * Loop agent. The goal itself arrives as the call-time prompt; these
 * instructions carry the standing working discipline (ported from the old
 * runLoopStep prompt preamble in src/app/api/loops/steps.ts).
 */
export function createLoopAgent(opts: {
  toolsContext: ReturnType<typeof buildLoopToolsContext>;
}): LoopAgent {
  return new WorkflowAgent({
    model: deepseek("deepseek-v4-flash"),
    temperature: 0.4,
    // V4 models default to thinking ENABLED — the loop worker matches the old
    // deepseek-chat behavior (non-thinking); its power is iteration, not depth.
    providerOptions: {
      deepseek: { thinking: { type: "disabled" as const } },
    },
    instructions: `You are an autonomous agent working a goal step by step, on your own, while the human is away.

Use your concept tools to read context: open specific slices with readSlice, browse with listSlices / readTimeline, follow topics with readStrand / listStrands. Work from what you find — do not re-read files that don't exist.

After each meaningful increment of work, call the loopReport tool exactly once to record the action you took, the result, and whether the goal is done. Set done=true only when the goal is genuinely complete — do not pad with busywork. Stop working once you have reported done=true.`,
    tools: loopTools,
    toolsContext: opts.toolsContext,
  });
}
