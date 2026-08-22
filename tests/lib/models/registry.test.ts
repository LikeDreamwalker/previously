import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ALL_MODELS,
  getAvailableModels,
  getModel,
  getModelOverrides,
  resolveModelId,
  getDefaultModelId,
} from "@/lib/models/registry";

const SAVED_ENV = { ...process.env };

describe("model registry", () => {
  beforeEach(() => {
    // Deterministic env: no provider keys configured by default.
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  // ─── Catalog shape ──────────────────────────────────────────────────

  it("includes DeepSeek and Anthropic models", () => {
    const providers = new Set(ALL_MODELS.map((m) => m.provider));
    expect(providers).toContain("deepseek");
    expect(providers).toContain("anthropic");
  });

  it("every model declares envKey, sdk, providerName, defaultThinking, defaultEffort", () => {
    for (const m of ALL_MODELS) {
      expect(m.envKey.length).toBeGreaterThan(0);
      expect(["deepseek", "anthropic", "openai"]).toContain(m.sdk);
      expect(m.providerName.length).toBeGreaterThan(0);
      expect(typeof m.defaultThinking).toBe("boolean");
      expect(["low", "medium", "high"]).toContain(m.defaultEffort);
    }
  });

  it("defaults thinking ON for every thinking-capable model", () => {
    for (const m of ALL_MODELS) {
      if (m.capabilities.thinking) {
        expect(m.defaultThinking).toBe(true);
      }
    }
  });

  it("does not override thinking in curated overrides (derives from capability)", () => {
    expect(getModelOverrides("deepseek-v4-flash")?.defaultThinking).toBeUndefined();
  });

  // ─── getAvailableModels (env-gated) ─────────────────────────────────

  it("returns nothing when no provider keys are set", () => {
    expect(getAvailableModels()).toHaveLength(0);
  });

  it("returns only DeepSeek models when only DEEPSEEK_API_KEY is set", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const models = getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "deepseek")).toBe(true);
  });

  it("returns only Anthropic models when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const models = getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "anthropic")).toBe(true);
  });

  it("returns both providers when both keys are set", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const providers = new Set(getAvailableModels().map((m) => m.provider));
    expect(providers.has("deepseek")).toBe(true);
    expect(providers.has("anthropic")).toBe(true);
  });

  // ─── getModel ───────────────────────────────────────────────────────

  it("returns a known model by id", () => {
    expect(getModel("deepseek-v4-pro")?.provider).toBe("deepseek");
    expect(getModel("claude-sonnet-5")?.provider).toBe("anthropic");
  });

  it("curates the DeepSeek multimodal model with vision capability", () => {
    const vision = getModel("deepseek-v4-flash-vision-exp");
    expect(vision?.capabilities.vision).toBe(true);
    expect(vision?.capabilities.thinking).toBe(true);
    expect(vision?.defaultEffort).toBe("low");
  });

  it("returns undefined for an unknown id", () => {
    expect(getModel("nope")).toBeUndefined();
  });

  // ─── resolveModelId (legacy migration) ──────────────────────────────

  it("maps legacy DeepSeek ids forward to V4", () => {
    expect(resolveModelId("deepseek-chat")).toBe("deepseek-v4-flash");
    expect(resolveModelId("deepseek-reasoner")).toBe("deepseek-v4-pro");
  });

  it("passes through current ids unchanged", () => {
    expect(resolveModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(resolveModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  // ─── getDefaultModelId ──────────────────────────────────────────────

  it("picks the first available model for the deployment", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getDefaultModelId()).toMatch(/^claude-/);
  });

  it("falls back to a hardcoded default when nothing is configured", () => {
    expect(getDefaultModelId()).toBe("deepseek-v4-flash");
  });
});
