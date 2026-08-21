/**
 * Thinking-effort injector — the single source of truth for mapping a
 * "low | medium | high" reasoning effort onto each provider SDK's own
 * providerOptions shape.
 *
 * Previously this mapping was duplicated (and drifted) across three call
 * sites: the chat agent factory (`agent.ts buildProviderOptions`), the
 * thinkDeep sub-agent (`tool-executors.ts subAgentProviderOptions`), and the
 * worker tier (`worker.ts workerProviderOptions`). This module replaces the
 * first two; the worker keeps its always-disabled shape (it has no effort
 * axis — worker calls are cheap structured tasks by construction).
 *
 * Why provider-specific:
 *   - deepseek: `thinking.type` (adaptive|enabled|disabled) + `reasoningEffort`
 *     (low|medium|high|xhigh|max). Effort maps 1:1 onto `reasoningEffort` —
 *     `low` is sent EXPLICITLY (V4 Flash preserves it as genuine low effort;
 *     verified 2026-08-08 that explicit `low` shortens thinking vs. sending
 *     nothing), `medium` stays honest, `high` stays high. V4 Pro promotes
 *     low/medium server-side regardless (out of our control). Thinking stays
 *     ENABLED across every effort tier — disabling is the thinking toggle's
 *     job (`thinking: false` → `{ type: "disabled" }`), not an effort tier.
 *   - anthropic: `thinking.type` always enabled; `budgetTokens` scales for
 *     medium/high, low uses the model's default budget.
 *   - openai (and OpenAI-compatible: Kimi, Qwen, ...): `reasoningEffort`.
 */
import type { ProviderSdk } from "./providers";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export type ProviderOptions = Record<string, JsonObject>;

/**
 * Map a user-facing reasoning effort onto provider-specific providerOptions.
 *
 * @param sdk      Provider SDK family (unknown/undefined → DeepSeek shape).
 * @param modelId  Retained for callers that pass it positionally; not consulted
 *                 by the current mapping (effort now maps 1:1 for all models).
 * @param thinking Whether thinking is enabled for the call. When false, every
 *                 provider gets a thinking-disabled shape (fast, structured).
 * @param effort   User-facing reasoning intensity.
 */
export function normalizeReasoningEffort(
  sdk: ProviderSdk | undefined,
  modelId: string,
  thinking: boolean,
  effort: "low" | "medium" | "high",
): ProviderOptions | undefined {
  // Thinking off — always disable reasoning regardless of effort.
  if (!thinking) {
    switch (sdk) {
      case "anthropic":
        return { anthropic: { thinking: { type: "disabled" } } };
      case "openai":
        return { openai: { reasoningEffort: "minimal" } };
      case "bridge":
        // The subscription bridge has no reasoning knobs at all.
        return undefined;
      default:
        // DeepSeek (default) — V4 defaults to thinking ENABLED, so "off" explicit.
        return { deepseek: { thinking: { type: "disabled" } } };
    }
  }

  switch (sdk) {
    case "anthropic":
      // Thinking stays ON for every effort. `low` uses the model's default
      // budget (no explicit budgetTokens); medium/high scale the budget.
      if (effort === "low") {
        return { anthropic: { thinking: { type: "enabled" } } };
      }
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: effort === "high" ? 32_000 : 12_000,
          },
        },
      };
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "bridge":
      // The subscription bridge has no reasoning knobs at all.
      return undefined;
    default: {
      // DeepSeek — send exactly the requested effort. No special-casing by
      // model id: V4 Flash preserves `low` as genuine low effort, so the honest
      // value is what the user asked for.
      return {
        deepseek: { thinking: { type: "enabled" }, reasoningEffort: effort },
      };
    }
  }
}
