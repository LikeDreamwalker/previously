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

import {
  WorkflowAgent,
  type WorkflowAgentOptions,
} from "@ai-sdk/workflow";
import { createModel } from "@/lib/models/provider";
import type { ModelConfig } from "@/lib/models/registry";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import { SOUL_MD } from "@/lib/identity/agent-prompt.generated";

/**
 * Strip the YAML frontmatter (---…---) off a bundled identity markdown string.
 * Kept inline (no gray-matter) so this module stays workflow-sandbox-pure:
 * only the compiled string constants cross this boundary.
 */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? md.slice(match[0].length).trim() : md.trim();
}
import {
  getChatTools,
  loopTools,
  type buildChatToolsContext,
  type buildLoopToolsContext,
} from "./tools";

// ─── Provider-aware providerOptions ──────────────────────────────────────
//
// Effort → providerOptions mapping is centralized in
// src/lib/models/effort-injector.ts (`normalizeReasoningEffort`) so the chat
// agent, thinkDeep sub-agents, and any future reasoning call share one
// provider-specific translation. `ProviderOptions` is exported there too
// (isomorphic to @ai-sdk/provider's JSONObject shape).

export type ChatToolSet = ReturnType<typeof getChatTools>;
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
  /** Fully resolved model config — carries sdk/baseURL/envKey for routing. */
  model: ModelConfig;
  thinking: boolean;
  reasoningEffort: "low" | "medium" | "high";
  toolsContext: ReturnType<typeof buildChatToolsContext>;
  /**
   * Fires after each completed LLM step — the turn workflow accumulates the
   * written text so a platform-killed step can be continued (续写) with the
   * partial output it produced before being cut off.
   */
  onStepEnd?: WorkflowAgentOptions<ChatToolSet>["onStepEnd"];
}): ChatAgent {
  const model = createModel(opts.model);

  // The bridge main model (client mode, PREVIOUSLY_BRAIN=bridge) shells out
  // to a subscription CLI that returns plain text — it CANNOT emit structured
  // tool calls, so the kernel tools (recall/readSlice/delegateTask/…) are not
  // mounted for it. The system prompt says this explicitly (see the bridge
  // notice in turn-workflow.ts). Memory reads still work on the bridge side:
  // the client spawns the CLI in a per-call skills workspace whose instruction
  // files (CLAUDE.md / AGENTS.md) explain how to read Previously's read-only
  // markdown memory (client repo's setup, not kernel tools).
  const isBridge = opts.model.sdk === "bridge";

  // NOTE: no `maxOutputTokens` — a project-wide prohibition. The step is bounded
  // only by the platform's 300s wall; on a kill the turn workflow continues the
  // agent with a nudge (see turn-workflow.ts) instead of truncating the model.
  return new WorkflowAgent({
    model,
    instructions:
      "You are the user's personal agent with layered episodic memory. Answer from the provided context; use the memory tools to recall details when needed.",
    ...(isBridge ? {} : { tools: getChatTools() }),
    toolsContext: opts.toolsContext,
    providerOptions: normalizeReasoningEffort(
      opts.model.sdk,
      opts.model.id,
      opts.thinking,
      opts.reasoningEffort,
    ),
    ...(opts.onStepEnd ? { onStepEnd: opts.onStepEnd } : {}),
  });
}

/**
 * Loop agent. The goal itself arrives as the call-time prompt; these
 * instructions carry the standing working discipline (ported from the old
 * runLoopStep prompt preamble in src/app/api/loops/steps.ts).
 */
export function createLoopAgent(opts: {
  toolsContext: ReturnType<typeof buildLoopToolsContext>;
  /** The resolved worker model for the loop brain (see src/lib/models/worker.ts). */
  model: ModelConfig;
}): LoopAgent {
  // The loop worker shares the agent's constitution (SOUL only — DIRECTIVES
  // mention the chat-only `recall` tool, so loops get identity + voice without
  // tool instructions they can't follow). The goal arrives as the call-time
  // prompt; these instructions carry the standing working discipline.
  const soulBody = stripFrontmatter(SOUL_MD);
  return new WorkflowAgent({
    model: createModel(opts.model),
    temperature: 0.4,
    // V4 models default to thinking ENABLED — the loop worker matches the old
    // deepseek-chat behavior (non-thinking); its power is iteration, not depth.
    providerOptions: {
      deepseek: { thinking: { type: "disabled" as const } },
    },
    instructions: `${soulBody}

---

You are now working as an autonomous background agent on a goal the user set, on your own, while the human is away.

Use your concept tools to read context: open specific slices with readSlice, browse with listSlices / readTimeline, follow topics with readStrand / listStrands. Work from what you find — do not re-read files that don't exist.

After each meaningful increment of work, call the loopReport tool exactly once to record the action you took, the result, and whether the goal is done. Set done=true only when the goal is genuinely complete — do not pad with busywork. Stop working once you have reported done=true.`,
    tools: loopTools,
    toolsContext: opts.toolsContext,
  });
}
