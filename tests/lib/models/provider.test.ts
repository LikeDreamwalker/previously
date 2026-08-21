import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { deepseekMock, createAnthropicMock, createOpenAIMock } = vi.hoisted(() => ({
  deepseekMock: vi.fn((id: string) => ({ kind: "deepseek", id })),
  createAnthropicMock: vi.fn(() => (id: string) => ({ kind: "anthropic", id })),
  createOpenAIMock: vi.fn((opts?: { baseURL?: string }) => (id: string) => ({
    kind: "openai",
    id,
    baseURL: opts?.baseURL,
  })),
}));

vi.mock("@ai-sdk/deepseek", () => ({ deepseek: deepseekMock }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: createAnthropicMock }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }));

import { createModel } from "@/lib/models/provider";
import type { ModelConfig } from "@/lib/models/registry";

const SAVED_ENV = { ...process.env };

/** Minimal ModelConfig fixture — only the fields createModel reads. */
function cfg(sdk: ModelConfig["sdk"], id: string, baseURL?: string): ModelConfig {
  return { sdk, id, ...(baseURL ? { baseURL } : {}), envKey: "X_API_KEY" } as ModelConfig;
}

describe("createModel", () => {
  beforeEach(() => {
    deepseekMock.mockClear();
    createAnthropicMock.mockClear();
    createOpenAIMock.mockClear();
    process.env.X_API_KEY = "sk-test";
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("dispatches deepseek-sdk models to the deepseek factory", () => {
    const model = createModel(cfg("deepseek", "deepseek-v4-pro"));
    expect(deepseekMock).toHaveBeenCalledWith("deepseek-v4-pro");
    expect(model).toEqual({ kind: "deepseek", id: "deepseek-v4-pro" });
  });

  it("dispatches anthropic-sdk models through createAnthropic", () => {
    const model = createModel(cfg("anthropic", "claude-sonnet-5"));
    expect(createAnthropicMock).toHaveBeenCalledTimes(1);
    expect(model).toEqual({ kind: "anthropic", id: "claude-sonnet-5" });
  });

  it("dispatches openai-sdk models through createOpenAI with the baseURL and env key", () => {
    const model = createModel(cfg("openai", "kimi-latest", "https://api.moonshot.ai/v1"));
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.moonshot.ai/v1",
        apiKey: "sk-test",
      }),
    );
    expect(model).toEqual({
      kind: "openai",
      id: "kimi-latest",
      baseURL: "https://api.moonshot.ai/v1",
    });
  });

  it("dispatches bridge-sdk models to the subscription bridge model", () => {
    const model = createModel(cfg("bridge", "bridge/claude"));
    expect(model).toMatchObject({
      provider: "previously-bridge",
      modelId: "bridge/claude",
      specificationVersion: "v3",
    });
  });
});
