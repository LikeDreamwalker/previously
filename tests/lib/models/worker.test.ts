import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ModelConfig } from "@/lib/models/registry";

// No real config I/O — stub the loader; the catalog returns a fixed list.
const loader = vi.hoisted(() => ({ loadUserConfig: vi.fn() }));
vi.mock("@/lib/config/loader", () => ({ loadUserConfig: loader.loadUserConfig }));
vi.mock("@/lib/models/catalog", () => ({
  resolveAvailableModels: vi.fn(async () => [
    {
      id: "kimi-latest",
      name: "Kimi Latest",
      provider: "moonshotai",
      providerName: "Moonshot",
      sdk: "openai",
      envKey: "MOONSHOT_API_KEY",
      capabilities: { thinking: true, vision: false, maxTokens: 131072 },
      defaultThinking: true,
      defaultEffort: "medium",
    },
    {
      id: "kimi-lite",
      name: "Kimi Lite",
      provider: "moonshotai",
      providerName: "Moonshot",
      sdk: "openai",
      envKey: "MOONSHOT_API_KEY",
      capabilities: { thinking: false, vision: false, maxTokens: 65536 },
      defaultThinking: false,
      defaultEffort: "low",
    },
  ]),
}));

import {
  resolveWorkerModel,
  workerProviderOptions,
} from "@/lib/models/worker";

const SAVED_ENV = { ...process.env };

const deepseekPro: ModelConfig = {
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: true,
  defaultEffort: "medium",
};

const claudeSonnet: ModelConfig = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  providerName: "Anthropic",
  sdk: "anthropic",
  envKey: "ANTHROPIC_API_KEY",
  capabilities: { thinking: true, vision: true, maxTokens: 200000 },
  defaultThinking: true,
  defaultEffort: "medium",
};

const kimiLatest: ModelConfig = {
  id: "kimi-latest",
  name: "Kimi Latest",
  provider: "moonshotai",
  providerName: "Moonshot",
  sdk: "openai",
  envKey: "MOONSHOT_API_KEY",
  baseURL: "https://api.moonshot.ai/v1",
  capabilities: { thinking: true, vision: false, maxTokens: 131072 },
  defaultThinking: true,
  defaultEffort: "medium",
};

beforeEach(() => {
  vi.clearAllMocks();
  loader.loadUserConfig.mockResolvedValue({ worker: { mode: "auto", provider: "" } });
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

// ─── workerProviderOptions ────────────────────────────────────────────────

describe("workerProviderOptions", () => {
  it("disables thinking per SDK", () => {
    expect(workerProviderOptions("anthropic")).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    expect(workerProviderOptions("openai")).toEqual({
      openai: { reasoningEffort: "minimal" },
    });
    expect(workerProviderOptions("deepseek")).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
  });

  it("defaults to the DeepSeek shape for an unknown sdk", () => {
    expect(workerProviderOptions(undefined)).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
  });
});

// ─── resolveWorkerModel ───────────────────────────────────────────────────

describe("resolveWorkerModel", () => {
  it("auto: uses the curated same-provider lightweight (haiku for anthropic)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const worker = await resolveWorkerModel(claudeSonnet);
    expect(worker.id).toBe("claude-haiku-4-5");
  });

  it("manual: an explicit pin wins", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    loader.loadUserConfig.mockResolvedValue({
      worker: { mode: "manual", provider: "claude-opus-4-8" },
    });
    const worker = await resolveWorkerModel(claudeSonnet);
    expect(worker.id).toBe("claude-opus-4-8");
  });

  it("falls back to the main model when no same-provider lightweight is configured", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    const worker = await resolveWorkerModel(deepseekPro);
    expect(worker.id).toBe("deepseek-v4-pro");
  });

  it("auto: picks the non-thinking model from the catalog for uncurated providers", async () => {
    process.env.MOONSHOT_API_KEY = "sk-moonshot";
    const worker = await resolveWorkerModel(kimiLatest);
    expect(worker.id).toBe("kimi-lite");
  });
});
