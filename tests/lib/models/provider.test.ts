import { describe, it, expect, vi, beforeEach } from "vitest";

const { deepseekMock, createAnthropicMock } = vi.hoisted(() => ({
  deepseekMock: vi.fn((id: string) => ({ kind: "deepseek", id })),
  createAnthropicMock: vi.fn(() => (id: string) => ({ kind: "anthropic", id })),
}));

vi.mock("@ai-sdk/deepseek", () => ({ deepseek: deepseekMock }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: createAnthropicMock }));

import { createModel } from "@/lib/models/provider";
import type { ModelConfig } from "@/lib/models/registry";

/** Minimal ModelConfig fixture — only the fields createModel reads. */
function cfg(provider: ModelConfig["provider"], id: string): ModelConfig {
  return { provider, id } as ModelConfig;
}

describe("createModel", () => {
  beforeEach(() => {
    deepseekMock.mockClear();
    createAnthropicMock.mockClear();
  });

  it("dispatches DeepSeek models to the deepseek factory", () => {
    const model = createModel(cfg("deepseek", "deepseek-v4-pro"));
    expect(deepseekMock).toHaveBeenCalledWith("deepseek-v4-pro");
    expect(model).toEqual({ kind: "deepseek", id: "deepseek-v4-pro" });
  });

  it("dispatches Anthropic models through createAnthropic", () => {
    const model = createModel(cfg("anthropic", "claude-sonnet-5"));
    expect(createAnthropicMock).toHaveBeenCalledTimes(1);
    expect(model).toEqual({ kind: "anthropic", id: "claude-sonnet-5" });
  });

  it("falls back to deepseek for unknown providers", () => {
    const model = createModel(cfg("openai", "some-model"));
    expect(deepseekMock).toHaveBeenCalledWith("some-model");
    expect(model).toEqual({ kind: "deepseek", id: "some-model" });
  });
});
