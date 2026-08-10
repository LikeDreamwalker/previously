/**
 * Per-provider LLM token budgets — Layer 1 of the v0.6 architecture.
 *
 * The Vercel Hobby plan caps a single workflow step at 300s. A single LLM call
 * inside the WorkflowAgent (`doStreamStep`) is one such step, so the budget
 * below is chosen so that even a worst-case slow generation finishes well
 * under the wall. DeepSeek's `max_tokens` does NOT constrain internal reasoning
 * length — it caps total (reasoning + answer) output — so its budget is the
 * most conservative: a 3500-token generation at ~15 tok/s ≈ 233s, leaving a
 * buffer for step overhead and TTFB variance. `timeout` at the stream call site
 * is the independent wall-clock safety fuse on top of this.
 *
 * Pure function module (no I/O) so it is safe to import from `"use workflow"`
 * files and unit-testable.
 */

import type { ProviderSdk } from "@/lib/models/providers";

/**
 * Conservative worst-case token cap per provider, keeping a single LLM
 * generation structurally under the 300s step limit.
 *
 * | sdk       | budget | rationale                              |
 * |-----------|--------|-----------------------------------------|
 * | deepseek  |  3500  | thinking models ~15 tok/s worst-case    |
 * | anthropic |  8000  | ~40 tok/s → 8000/40 = 200s              |
 * | openai    |  6000  | OpenAI-compatible ~30 tok/s → 200s      |
 *
 * Unknown sdk (undefined) falls through to the openai-compatible default.
 */
export function tokenBudget(sdk: ProviderSdk | undefined): number {
  switch (sdk) {
    case "deepseek":
      return 3_500;
    case "anthropic":
      return 8_000;
    default:
      return 6_000;
  }
}
