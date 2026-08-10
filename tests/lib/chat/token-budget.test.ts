import { describe, it, expect } from "vitest";
import { tokenBudget } from "@/lib/chat/token-budget";

describe("tokenBudget", () => {
  it("caps DeepSeek most conservatively (thinking models, no reasoning cap)", () => {
    expect(tokenBudget("deepseek")).toBe(3_500);
  });

  it("allows the largest budget for Anthropic", () => {
    expect(tokenBudget("anthropic")).toBe(8_000);
  });

  it("defaults OpenAI-compatible providers to the middle budget", () => {
    expect(tokenBudget("openai")).toBe(6_000);
  });

  it("falls through to the default for unknown/undefined sdk", () => {
    expect(tokenBudget(undefined)).toBe(6_000);
  });
});
