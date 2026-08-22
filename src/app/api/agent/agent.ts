/**
 * Shared WorkflowAgent factory — the agent brain behind the chat-turn
 * workflow.
 *
 * Constructed INSIDE the "use workflow" body (the official pattern): the
 * agent loop then runs in the Workflow runtime, so every LLM call and every
 * tool call is an individually durable, auto-retried step.
 *
 * Import-graph discipline: pure JS only (WorkflowAgent + provider factories
 * are object construction, no I/O). All Node I/O lives behind the "use step"
 * tool executors bound in ./tools.
 */

import {
  WorkflowAgent,
  type PrepareCallOptions,
  type PrepareCallResult,
  type WorkflowAgentOptions,
} from "@ai-sdk/workflow";
import type { ModelMessage } from "ai";
import { createModel } from "@/lib/models/provider";
import type { ModelConfig } from "@/lib/models/registry";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import {
  chatTools,
  type buildChatToolsContext,
} from "./tools";

// ─── Provider-aware providerOptions ──────────────────────────────────────
//
// Effort → providerOptions mapping is centralized in
// src/lib/models/effort-injector.ts (`normalizeReasoningEffort`) so the chat
// agent, thinkDeep sub-agents, and any future reasoning call share one
// provider-specific translation. `ProviderOptions` is exported there too
// (isomorphic to @ai-sdk/provider's JSONObject shape).

export type ChatToolSet = typeof chatTools;
export type ChatAgent = WorkflowAgent<ChatToolSet>;

// ─── Anthropic explicit cache breakpoints (best-effort) ──────────────────
//
// DeepSeek needs nothing here: it does AUTOMATIC prefix caching on
// byte-identical request prefixes, which the slice-frozen system prompt
// already maximizes (see turn-workflow.ts). Anthropic caching is opt-in via
// per-message `cacheControl` breakpoints in message-level providerOptions,
// so we place two — both frozen for a slice's lifetime, so cache hits span
// every turn of the slice:
//   1. on the system prompt (the big frozen L0-L5 block);
//   2. on the LAST history message (everything before the live agent steps;
//      tool steps appended later stay uncached, by design).
// Applied via prepareCall (runs once per agent.stream call), so a timeout
// continuation re-applies both breakpoints to its rebuilt context. Other
// providers never see these providerOptions — gated on sdk at the call site.
const ANTHROPIC_CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

function withAnthropicCacheBreakpoints(
  options: PrepareCallOptions<ChatToolSet>,
): PrepareCallResult<ChatToolSet> {
  const { instructions, messages } = options;
  return {
    // The turn workflow always passes the system prompt as a string; wrap it
    // in a SystemModelMessage so the breakpoint rides along. (Anything else
    // passes through untouched.)
    instructions:
      typeof instructions === "string"
        ? [
            {
              role: "system" as const,
              content: instructions,
              providerOptions: ANTHROPIC_CACHE_BREAKPOINT,
            },
          ]
        : instructions,
    messages: markHistoryEndBreakpoint(messages),
  };
}

/** Copy `messages` with an ephemeral-cache breakpoint on the last one. */
function markHistoryEndBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        ...ANTHROPIC_CACHE_BREAKPOINT,
      },
    } as ModelMessage,
  ];
}

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

  // NOTE: no `maxOutputTokens` — a project-wide prohibition. The step is bounded
  // only by the platform's 300s wall; on a kill the turn workflow continues the
  // agent with a nudge (see turn-workflow.ts) instead of truncating the model.
  return new WorkflowAgent({
    model,
    instructions:
      "You are the user's personal agent with layered episodic memory. Answer from the provided context; use the memory tools to recall details when needed.",
    tools: chatTools,
    toolsContext: opts.toolsContext,
    providerOptions: normalizeReasoningEffort(
      opts.model.sdk,
      opts.model.id,
      opts.thinking,
      opts.reasoningEffort,
    ),
    // Best-effort Anthropic prompt caching — see the block comment above.
    ...(opts.model.sdk === "anthropic"
      ? { prepareCall: withAnthropicCacheBreakpoints }
      : {}),
    ...(opts.onStepEnd ? { onStepEnd: opts.onStepEnd } : {}),
  });
}
