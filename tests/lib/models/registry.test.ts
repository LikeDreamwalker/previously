import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_MODELS,
  BYOK_PROVIDERS,
  getAvailableModels,
  getByokModel,
  getModel,
  resolveModelId,
  getDefaultModelId,
} from "@/lib/models/registry";

const SAVED_ENV = { ...process.env };

describe("model registry", () => {
  beforeEach(() => {
    // Deterministic env: no provider keys configured by default, no
    // client-mode state (PREVIOUSLY_HOME / brain / default-model injection).
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PREVIOUSLY_MODE;
    delete process.env.PREVIOUSLY_HOME;
    delete process.env.PREVIOUSLY_BRAIN;
    delete process.env.PREVIOUSLY_BRAIN_AGENT;
    delete process.env.PREVIOUSLY_DEFAULT_MODEL;
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

  it("defaults effort to LOW for every user-selectable model", () => {
    // Fast responses are the product rule; deep thinking is thinkDeep's job.
    // startTurn pins effort=low server-side regardless — the catalog default
    // must agree so the UI seed and the actual call never diverge.
    for (const m of ALL_MODELS) {
      expect(m.defaultEffort).toBe("low");
    }
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

  // ─── BYOK (client mode, config.json `byok` section) ─────────────────

  describe("getByokModel", () => {
    const byok = { provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" };

    it("returns undefined without a byok section or in cloud mode", () => {
      process.env.PREVIOUSLY_MODE = "client";
      expect(getByokModel(null)).toBeUndefined();
      expect(getByokModel(undefined)).toBeUndefined();
      process.env.PREVIOUSLY_MODE = "cloud";
      expect(getByokModel(byok)).toBeUndefined();
    });

    it("builds the byok/<model> entry on the openai-compatible sdk path", () => {
      process.env.PREVIOUSLY_MODE = "client";
      const m = getByokModel(byok);
      expect(m).toMatchObject({
        id: "byok/deepseek-chat",
        provider: "byok",
        providerName: "Your API key",
        sdk: "openai",
        // The preset baseURL comes from BYOK_PROVIDERS, the key from config.
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-byok",
        defaultThinking: false,
        defaultEffort: "low",
      });
      expect(m?.name).toContain("(BYOK)");
      expect(m?.capabilities.thinking).toBe(false);
    });

    it("uses the custom baseUrl for custom providers", () => {
      process.env.PREVIOUSLY_MODE = "client";
      const m = getByokModel({
        provider: "custom",
        apiKey: "sk-x",
        baseUrl: "https://llm.example.com/v1",
        model: "my-model",
      });
      expect(m?.id).toBe("byok/my-model");
      expect(m?.baseURL).toBe("https://llm.example.com/v1");
    });

    it("covers every preset the settings UI offers (minus custom)", () => {
      // The UI's provider list mirrors these keys — a drift breaks validation
      // (client-config validateByok accepts exactly these + custom).
      expect(BYOK_PROVIDERS.map((p) => p.key)).toEqual([
        "deepseek",
        "openai",
        "moonshotai",
        "alibaba",
        "google",
        "mistral",
        "xai",
        "groq",
      ]);
    });
  });

  // ─── getDefaultModelId with BYOK (no env-key models) ────────────────

  describe("getDefaultModelId with BYOK", () => {
    let home: string;

    const writeByok = (byok: unknown) =>
      writeFile(join(home, "config.json"), JSON.stringify({ byok }));

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "previously-home-"));
      process.env.PREVIOUSLY_MODE = "client";
      process.env.PREVIOUSLY_HOME = home;
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("prefers the byok entry when no env-key model is available", async () => {
      await writeByok({ provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" });
      expect(getDefaultModelId()).toBe("byok/deepseek-chat");
    });

    it("keeps the first env-key model as the default when one is available", async () => {
      await writeByok({ provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" });
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      expect(getDefaultModelId()).toMatch(/^claude-/);
    });

    it("uses PREVIOUSLY_DEFAULT_MODEL when the byok section omits model", async () => {
      await writeByok({ provider: "deepseek", apiKey: "sk-byok" });
      process.env.PREVIOUSLY_DEFAULT_MODEL = "deepseek-v4-pro";
      expect(getDefaultModelId()).toBe("byok/deepseek-v4-pro");
    });

    it("falls back to ALL_MODELS[0] on a missing/corrupt config.json (never throws)", async () => {
      // Missing file.
      expect(getDefaultModelId()).toBe("deepseek-v4-flash");
      // Corrupt file.
      await writeFile(join(home, "config.json"), "{ not json");
      expect(getDefaultModelId()).toBe("deepseek-v4-flash");
    });

    it("resolves a byok default id back to its config (the start-turn chain)", async () => {
      await writeByok({ provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" });
      const id = getDefaultModelId();
      expect(getModel(id)?.provider).toBe("byok");
      expect(getModel(id)?.apiKey).toBe("sk-byok");
    });
  });
});
