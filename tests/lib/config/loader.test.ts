import { describe, it, expect, vi, afterEach } from "vitest";

// The loader computes its data source at import time, so this file stubs the
// env to "demo" and dynamic-imports the module fresh (per-file module registry
// keeps it isolated from other test files).
const mockReadDemo = vi.fn();
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: (path: string) => mockReadDemo(path),
}));

// Loaded once (module instance is cached across dynamic imports) — the loader
// computes its SOURCE at first eval, so the env must be stubbed before that.
// DEMO_LOCK=1 activates the demo model lock exercised by these tests.
async function loadDemoLoader() {
  vi.stubEnv("STORAGE", "demo");
  vi.stubEnv("DEMO_LOCK", "1");
  return import("@/lib/config/loader");
}

describe("loadUserConfig cache + invalidation", () => {
  afterEach(async () => {
    // The loader module (and its in-memory cache) is shared across tests in
    // this file — drop the cache so one test's reads don't leak into the next.
    const { invalidateUserConfigCache } = await loadDemoLoader();
    invalidateUserConfigCache();
    vi.unstubAllEnvs();
    mockReadDemo.mockReset();
  });

  it("serves the cached config on repeated reads", async () => {
    const { loadUserConfig } = await loadDemoLoader();
    mockReadDemo.mockResolvedValue(
      JSON.stringify({
        model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "medium" },
      }),
    );

    const first = await loadUserConfig();
    const second = await loadUserConfig();

    // Demo mode clamps the model to the locked value (see lib/demo/model-lock).
    expect(first.model.provider).toBe("deepseek-v4-flash-vision-exp");
    expect(second.model.provider).toBe("deepseek-v4-flash-vision-exp");
    // One read, not two.
    expect(mockReadDemo).toHaveBeenCalledTimes(1);
  });

  it("invalidateUserConfigCache forces a re-read of changed config", async () => {
    const { loadUserConfig, invalidateUserConfigCache } = await loadDemoLoader();
    // In demo mode the stored provider is clamped to the lock, so the visible
    // difference comes from the lock's own env override changing between reads.
    vi.stubEnv("DEMO_MODEL", "locked-a");
    mockReadDemo.mockResolvedValueOnce(
      JSON.stringify({ model: { provider: "a", thinking: true, reasoningEffort: "low" } }),
    );
    const first = await loadUserConfig();
    expect(first.model.provider).toBe("locked-a");

    vi.stubEnv("DEMO_MODEL", "locked-b");
    mockReadDemo.mockResolvedValueOnce(
      JSON.stringify({ model: { provider: "b", thinking: false, reasoningEffort: "high" } }),
    );
    invalidateUserConfigCache();

    const fresh = await loadUserConfig();
    expect(fresh.model.provider).toBe("locked-b");
    expect(mockReadDemo).toHaveBeenCalledTimes(2);
  });

  it("clamps the stored model to the demo lock", async () => {
    const { loadUserConfig } = await loadDemoLoader();
    mockReadDemo.mockResolvedValue(
      JSON.stringify({
        model: { provider: "claude-opus-4-8", thinking: false, reasoningEffort: "high" },
      }),
    );

    const config = await loadUserConfig();
    expect(config.model.provider).toBe("deepseek-v4-flash-vision-exp");
    expect(config.model.thinking).toBe(true);
    expect(config.model.reasoningEffort).toBe("low");
  });

  it("falls back to defaults when the config file is missing", async () => {
    const { loadUserConfig, invalidateUserConfigCache } = await loadDemoLoader();
    mockReadDemo.mockResolvedValueOnce(null);

    const config = await loadUserConfig();
    expect(config.model.provider).toBeTruthy(); // merged defaults, not a throw

    invalidateUserConfigCache();
  });
});
