import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildFromModelsDev,
  __resetCatalogCache,
} from "@/lib/models/catalog";

const SAVED_ENV = { ...process.env };

/** A minimal models.dev-shaped payload covering the merge rules. */
function fakeModelsDev() {
  return {
    deepseek: {
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      api: "https://api.deepseek.com/v1",
      models: {
        "deepseek-v4-flash": {
          id: "deepseek-v4-flash",
          name: "V4 Flash",
          reasoning: false,
          limit: { context: 65536 },
          modalities: { output: ["text"] },
        },
      },
    },
    moonshotai: {
      name: "Moonshot",
      env: ["MOONSHOT_API_KEY"],
      api: "https://api.moonshot.ai/v1",
      models: {
        "kimi-latest": {
          id: "kimi-latest",
          name: "Kimi Latest",
          reasoning: true,
          attachment: true,
          limit: { context: 131072 },
        },
        "kimi-k2.5": {
          id: "kimi-k2.5",
          name: "Kimi K2.5",
          reasoning: true,
          limit: { context: 262144 },
        },
      },
    },
    openai: {
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      api: "https://api.openai.com/v1",
      models: {
        "gpt-5.4": {
          id: "gpt-5.4",
          name: "GPT-5.4",
          reasoning: true,
          modalities: { output: ["text"] },
        },
        "text-embedding-3": {
          id: "text-embedding-3",
          name: "Embedding",
          modalities: { output: ["embedding"] },
        },
      },
    },
  };
}

describe("buildFromModelsDev", () => {
  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    __resetCatalogCache();
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("includes models only for providers whose key is configured", () => {
    process.env.MOONSHOT_API_KEY = "sk";
    process.env.DEEPSEEK_API_KEY = "sk";
    const models = buildFromModelsDev(fakeModelsDev());
    const providers = new Set(models.map((m) => m.provider));
    expect(providers.has("deepseek")).toBe(true);
    expect(providers.has("moonshotai")).toBe(true);
    expect(providers.has("openai")).toBe(false); // OPENAI not configured
  });

  it("routes unknown providers to the openai sdk and carries baseURL + envKey", () => {
    process.env.MOONSHOT_API_KEY = "sk";
    const kimi = buildFromModelsDev(fakeModelsDev()).find((m) => m.id === "kimi-latest");
    expect(kimi).toBeDefined();
    expect(kimi?.sdk).toBe("openai");
    expect(kimi?.baseURL).toBe("https://api.moonshot.ai/v1");
    expect(kimi?.envKey).toBe("MOONSHOT_API_KEY");
    expect(kimi?.providerName).toBe("Moonshot");
  });

  it("derives defaultThinking from models.dev reasoning (thinking on if supported)", () => {
    process.env.MOONSHOT_API_KEY = "sk";
    process.env.DEEPSEEK_API_KEY = "sk";
    const models = buildFromModelsDev(fakeModelsDev());
    const kimi = models.find((m) => m.id === "kimi-latest");
    expect(kimi?.defaultThinking).toBe(true); // reasoning: true → thinking on
    const flash = models.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.defaultThinking).toBe(false); // reasoning: false → no thinking support
  });

  it("drops non-chat models (no text output)", () => {
    process.env.OPENAI_API_KEY = "sk";
    const models = buildFromModelsDev(fakeModelsDev());
    expect(models.some((m) => m.id === "text-embedding-3")).toBe(false);
    expect(models.some((m) => m.id === "gpt-5.4")).toBe(true);
  });
});

describe("resolveAvailableModels fallback", () => {
  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
    vi.unstubAllGlobals();
    __resetCatalogCache();
  });

  it("falls back to the curated list when models.dev is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    process.env.DEEPSEEK_API_KEY = "sk";
    const { resolveAvailableModels } = await import("@/lib/models/catalog");
    const models = await resolveAvailableModels();
    expect(models.some((m) => m.id === "deepseek-v4-flash")).toBe(true);
  });
});

describe("resolveAvailableModels reverse filter", () => {
  beforeEach(() => {
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    __resetCatalogCache();
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
    vi.unstubAllGlobals();
    __resetCatalogCache();
  });

  it("prunes to the provider's live /models list, keeping the rest on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "https://models.dev/api.json") {
          return Promise.resolve({ ok: true, json: async () => fakeModelsDev() });
        }
        // Moonshot's live list only serves kimi-latest → kimi-k2.5 must drop.
        if (url === "https://api.moonshot.ai/v1/models") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: [{ id: "kimi-latest" }] }),
          });
        }
        // DeepSeek's /models is not mocked → fetch fails → keep its list.
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }),
    );
    process.env.MOONSHOT_API_KEY = "sk";
    process.env.DEEPSEEK_API_KEY = "sk";

    const { resolveAvailableModels } = await import("@/lib/models/catalog");
    const models = await resolveAvailableModels();

    const kimiModels = models.filter((m) => m.provider === "moonshotai");
    expect(kimiModels.map((m) => m.id)).toEqual(["kimi-latest"]);

    // DeepSeek's live fetch failed → all its models.dev models are kept.
    expect(models.some((m) => m.id === "deepseek-v4-flash")).toBe(true);
  });
});
