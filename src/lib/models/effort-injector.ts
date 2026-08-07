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
 *     (low|medium|high|xhigh|max). DeepSeek's own API normalizes the effort
 *     server-side per model: V4 Flash preserves `low` as genuine low effort;
 *     V4 Pro maps low/medium→high and xhigh→max (the `@ai-sdk/deepseek`
 *     source comment documents the V4 Pro behavior). HARD RULE: thinking is
 *     NEVER disabled for the agent — `low` means the model's default strength
 *     (no effort override), never `thinking: disabled`. `low` on V4 Flash maps
 *     to the model's preserved-low tier; medium on V4 Pro is promoted to high
 *     server-side regardless.
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

/** True when the model id is DeepSeek V4 Flash (which preserves `low` effort). */
function isDeepSeekV4Flash(modelId: string): boolean {
  return modelId.toLowerCase().includes("deepseek-v4-flash");
}

/**
 * Map a user-facing reasoning effort onto provider-specific providerOptions.
 *
 * @param sdk      Provider SDK family (unknown/undefined → DeepSeek shape).
 * @param modelId  Model id — DeepSeek V4 Flash vs Pro differ in effort mapping.
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
    default: {
      // DeepSeek. Thinking is ALWAYS enabled for the agent — never disable it
      // (a disabled-thinking "low" was the root of the perceived timeout: the
      // model fell back to its server-side default intensity anyway).
      //   - low    → no reasoningEffort override — the model's default strength.
      //   - medium → `low` on V4 Flash (its native preserved-low tier) / `medium`
      //              on V4 Pro (the server promotes it to high anyway).
      //   - high   → explicit `high`.
      if (effort === "low") {
        return { deepseek: { thinking: { type: "enabled" } } };
      }
      const reasoningEffort =
        effort === "high" ? "high" : isDeepSeekV4Flash(modelId) ? "low" : "medium";
      return {
        deepseek: { thinking: { type: "enabled" }, reasoningEffort },
      };
    }
  }
}
