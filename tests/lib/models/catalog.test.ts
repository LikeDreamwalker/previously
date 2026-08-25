import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAvailableModels, __resetCatalogCache } from "@/lib/models/catalog";

const SAVED_ENV = { ...process.env };

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  // BYOK/bridge state must not leak in from the developer's shell.
  delete process.env.PREVIOUSLY_MODE;
  delete process.env.PREVIOUSLY_HOME;
  delete process.env.PREVIOUSLY_BRAIN;
  delete process.env.PREVIOUSLY_BRAIN_AGENT;
  __resetCatalogCache();
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.unstubAllGlobals();
  __resetCatalogCache();
});

describe("resolveAvailableModels (live provider lists)", () => {
  it("lists only providers whose key is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url.startsWith("https://api.deepseek.com")
          ? jsonResponse({ data: [{ id: "deepseek-v4-flash" }] })
          : Promise.resolve({ ok: false }),
      ),
    );
    process.env.DEEPSEEK_API_KEY = "sk";
    const models = await resolveAvailableModels();
    expect(models.some((m) => m.provider === "deepseek")).toBe(true);
    expect(models.some((m) => m.provider === "openai")).toBe(false);
    expect(models.some((m) => m.provider === "moonshotai")).toBe(false);
  });

  it("normalizes legacy deepseek ids to their current curated name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "deepseek-chat" }] })));
    process.env.DEEPSEEK_API_KEY = "sk";
    const models = await resolveAvailableModels();
    const flash = models.find((m) => m.provider === "deepseek");
    expect(flash?.id).toBe("deepseek-v4-flash");
    expect(flash?.name).toBe("DeepSeek V4 Flash");
  });

  it("dedupes when legacy + current names both come back live", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-chat" }] }),
      ),
    );
    process.env.DEEPSEEK_API_KEY = "sk";
    const models = await resolveAvailableModels();
    const flash = models.filter((m) => m.id === "deepseek-v4-flash");
    expect(flash.length).toBe(1);
  });

  it("synthesizes metadata for unknown live ids with provider defaults", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "kimi-k2.5" }] })));
    process.env.MOONSHOT_API_KEY = "sk";
    const models = await resolveAvailableModels();
    const kimi = models.find((m) => m.id === "kimi-k2.5");
    expect(kimi?.sdk).toBe("openai");
    expect(kimi?.baseURL).toBe("https://api.moonshot.cn/v1");
    expect(kimi?.envKey).toBe("MOONSHOT_API_KEY");
    expect(kimi?.providerName).toBe("Moonshot AI");
    // OpenAI-compatible unknown models default to thinking off (don't send
    // reasoning params to providers that may not support them).
    expect(kimi?.defaultThinking).toBe(false);
  });

  it("drops non-chat ids from openai-compatible lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: [{ id: "gpt-5.4" }, { id: "text-embedding-3" }, { id: "whisper-1" }] }),
      ),
    );
    process.env.OPENAI_API_KEY = "sk";
    const models = await resolveAvailableModels();
    expect(models.some((m) => m.id === "gpt-5.4")).toBe(true);
    expect(models.some((m) => m.id === "text-embedding-3")).toBe(false);
    expect(models.some((m) => m.id === "whisper-1")).toBe(false);
  });

  it("falls back to curated entries when a provider's live list fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    process.env.DEEPSEEK_API_KEY = "sk";
    const models = await resolveAvailableModels();
    expect(models.some((m) => m.id === "deepseek-v4-flash")).toBe(true);
  });

  it("sends the API key VALUE (not the env var name) to live list endpoints", async () => {
    // v0.8.1 regression: the catalog used to pass the env var NAME as the
    // Bearer credential, so every live list 401'd and only curated fallback
    // entries (no deepseek-v4-flash-vision-exp) ever appeared.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: "deepseek-v4-flash-vision-exp" }] }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEEPSEEK_API_KEY = "sk-real-value";
    const models = await resolveAvailableModels();
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Authorization).toBe("Bearer sk-real-value");
    // The live id matches a curated entry — vision metadata comes through.
    const vision = models.find((m) => m.id === "deepseek-v4-flash-vision-exp");
    expect(vision?.capabilities.vision).toBe(true);
    expect(vision?.name).toBe("DeepSeek V4 Flash Vision (Exp)");
  });

  it("caches the resolved list within the TTL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: "deepseek-v4-flash" }] }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEEPSEEK_API_KEY = "sk";

    const first = await resolveAvailableModels();
    const second = await resolveAvailableModels();
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAvailableModels — BYOK entries (client mode)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "previously-catalog-byok-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeByok(byok: unknown): Promise<void> {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({ byok }));
  }

  it("appends the byok/<model> entry when config.json has a byok section", async () => {
    await writeByok({ provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" });
    const models = await resolveAvailableModels();
    const entry = models.find((m) => m.id === "byok/deepseek-chat");
    expect(entry).toMatchObject({
      provider: "byok",
      sdk: "openai",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-byok",
    });
  });

  it("lists BYOK after the bridge entries (outsourcing is the default)", async () => {
    process.env.PREVIOUSLY_BRAIN = "bridge";
    await writeByok({ provider: "openai", apiKey: "sk-byok", model: "gpt-5.4" });
    const models = await resolveAvailableModels();
    const lastBridge = models.map((m) => m.provider).lastIndexOf("bridge");
    const byokIndex = models.findIndex((m) => m.provider === "byok");
    expect(lastBridge).toBeGreaterThanOrEqual(0);
    expect(byokIndex).toBeGreaterThan(lastBridge);
  });

  it("never lists BYOK in cloud mode", async () => {
    process.env.PREVIOUSLY_HOME = home;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ byok: { provider: "openai", apiKey: "sk", model: "gpt-5.4" } }),
    );
    // PREVIOUSLY_MODE unset = cloud.
    const models = await resolveAvailableModels();
    expect(models.some((m) => m.provider === "byok")).toBe(false);
  });

  it("omits BYOK when config.json is missing or corrupt", async () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_HOME = home;
    // No config.json at all.
    expect((await resolveAvailableModels()).some((m) => m.provider === "byok")).toBe(false);
    // Corrupt config.json must not break model listing.
    __resetCatalogCache();
    await writeFile(join(home, "config.json"), "{ not json");
    expect((await resolveAvailableModels()).some((m) => m.provider === "byok")).toBe(false);
  });
});
