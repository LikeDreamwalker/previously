import { describe, it, expect } from "vitest";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";

// ─── Thinking OFF ─────────────────────────────────────────────────────────

describe("normalizeReasoningEffort — thinking OFF", () => {
  it("disables thinking per SDK regardless of effort", () => {
    expect(normalizeReasoningEffort("deepseek", "deepseek-v4-flash", false, "high")).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
    expect(normalizeReasoningEffort("anthropic", "claude-sonnet-5", false, "high")).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    expect(normalizeReasoningEffort("openai", "kimi-latest", false, "medium")).toEqual({
      openai: { reasoningEffort: "minimal" },
    });
  });

  it("defaults to the DeepSeek shape for an unknown sdk", () => {
    expect(normalizeReasoningEffort(undefined, "unknown", false, "low")).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
  });
});

// ─── DeepSeek ─────────────────────────────────────────────────────────────

describe("normalizeReasoningEffort — DeepSeek thinking ON", () => {
  it("V4 Flash: low sends the explicit preserved-low tier", () => {
    expect(
      normalizeReasoningEffort("deepseek", "deepseek-v4-flash", true, "low"),
    ).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "low" },
    });
  });

  it("V4 Flash: medium stays honest", () => {
    expect(
      normalizeReasoningEffort("deepseek", "deepseek-v4-flash", true, "medium"),
    ).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "medium" },
    });
  });

  it("V4 Flash: high enables thinking with explicit high", () => {
    expect(
      normalizeReasoningEffort("deepseek", "deepseek-v4-flash", true, "high"),
    ).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    });
  });

  it("V4 Pro: low sends the explicit value (server promotes it to high)", () => {
    expect(
      normalizeReasoningEffort("deepseek", "deepseek-v4-pro", true, "low"),
    ).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "low" },
    });
  });

  it("V4 Pro: medium keeps the honest medium value (server promotes to high)", () => {
    expect(
      normalizeReasoningEffort("deepseek", "deepseek-v4-pro", true, "medium"),
    ).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "medium" },
    });
  });

  it("V4 Pro: high enables thinking with explicit high", () => {
    expect(
      normalizeReasoningEffort("deepseek", "deepseek-v4-pro", true, "high"),
    ).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    });
  });
});

// ─── Anthropic ────────────────────────────────────────────────────────────

describe("normalizeReasoningEffort — Anthropic thinking ON", () => {
  it("low: thinking stays enabled with the model's default budget", () => {
    expect(
      normalizeReasoningEffort("anthropic", "claude-sonnet-5", true, "low"),
    ).toEqual({ anthropic: { thinking: { type: "enabled" } } });
  });

  it("medium: enabled with a 12k token budget", () => {
    expect(
      normalizeReasoningEffort("anthropic", "claude-sonnet-5", true, "medium"),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    });
  });

  it("high: enabled with a 32k token budget", () => {
    expect(
      normalizeReasoningEffort("anthropic", "claude-opus-4-8", true, "high"),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 32_000 } },
    });
  });
});

// ─── OpenAI-compatible ────────────────────────────────────────────────────

describe("normalizeReasoningEffort — OpenAI-compatible thinking ON", () => {
  it("maps effort directly to reasoningEffort", () => {
    expect(
      normalizeReasoningEffort("openai", "kimi-latest", true, "low"),
    ).toEqual({ openai: { reasoningEffort: "low" } });
    expect(
      normalizeReasoningEffort("openai", "kimi-latest", true, "medium"),
    ).toEqual({ openai: { reasoningEffort: "medium" } });
    expect(
      normalizeReasoningEffort("openai", "kimi-latest", true, "high"),
    ).toEqual({ openai: { reasoningEffort: "high" } });
  });
});
