import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  createOpenAICompatibleMock,
  createAnthropicMock,
  createOpenAIMock,
} = vi.hoisted(() => ({
  createOpenAICompatibleMock: vi.fn(
    (opts?: { name?: string; baseURL?: string }) => (id: string) => ({
      kind: "openai-compatible",
      id,
      name: opts?.name,
      baseURL: opts?.baseURL,
    }),
  ),
  createAnthropicMock: vi.fn(() => (id: string) => ({ kind: "anthropic", id })),
  createOpenAIMock: vi.fn((opts?: { baseURL?: string }) => (id: string) => ({
    kind: "openai",
    id,
    baseURL: opts?.baseURL,
  })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
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
    createOpenAICompatibleMock.mockClear();
    createAnthropicMock.mockClear();
    createOpenAIMock.mockClear();
    process.env.X_API_KEY = "sk-test";
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("routes deepseek models through createOpenAICompatible named 'deepseek'", () => {
    const model = createModel(cfg("deepseek", "deepseek-v4-pro", "https://api.deepseek.com"));
    // The name MUST stay "deepseek" — it becomes the providerOptions key that
    // effort-injector.ts emits ({ deepseek: { thinking, reasoningEffort } }).
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-test",
      }),
    );
    expect(model).toEqual({
      kind: "openai-compatible",
      id: "deepseek-v4-pro",
      name: "deepseek",
      baseURL: "https://api.deepseek.com",
    });
  });

  it("defaults the deepseek baseURL when the config carries none", () => {
    createModel(cfg("deepseek", "deepseek-v4-flash"));
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.deepseek.com" }),
    );
  });

  it("falls back to the deepseek-compatible factory for unknown sdks", () => {
    // Distinct baseURL so the provider-instance cache doesn't hit.
    const model = createModel(
      cfg("nope" as ModelConfig["sdk"], "some-model", "https://fallback.example/v1"),
    );
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deepseek",
        baseURL: "https://fallback.example/v1",
      }),
    );
    expect(model).toMatchObject({ kind: "openai-compatible", id: "some-model" });
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

  it("prefers an explicit config apiKey (BYOK) over the environment", () => {
    const model = createModel({
      ...cfg("openai", "byok/gpt-5.4", "https://api.openai.com/v1"),
      apiKey: "sk-from-config",
    });
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-from-config",
      }),
    );
    // The `byok/` selection prefix is stripped — the API gets the bare model.
    expect(model).toMatchObject({ kind: "openai", id: "gpt-5.4" });
  });

  it("keys the provider-instance cache on the apiKey (a changed key = a new instance)", () => {
    // Distinct baseURL so earlier tests' cache entries can't interfere.
    const base = "https://cache-key-test.example/v1";
    createModel({ ...cfg("openai", "m1", base), apiKey: "sk-one" });
    createModel({ ...cfg("openai", "m1", base), apiKey: "sk-one" });
    expect(createOpenAIMock).toHaveBeenCalledTimes(1);
    createModel({ ...cfg("openai", "m1", base), apiKey: "sk-two" });
    expect(createOpenAIMock).toHaveBeenCalledTimes(2);
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
