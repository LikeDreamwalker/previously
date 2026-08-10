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
async function loadDemoLoader() {
  vi.stubEnv("STORAGE", "demo");
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

    expect(first.model.provider).toBe("deepseek-v4-flash");
    expect(second.model.provider).toBe("deepseek-v4-flash");
    // One read, not two.
    expect(mockReadDemo).toHaveBeenCalledTimes(1);
  });

  it("invalidateUserConfigCache forces a re-read of changed config", async () => {
    const { loadUserConfig, invalidateUserConfigCache } = await loadDemoLoader();
    mockReadDemo.mockResolvedValueOnce(
      JSON.stringify({ model: { provider: "a", thinking: true, reasoningEffort: "low" } }),
    );
    await loadUserConfig();

    mockReadDemo.mockResolvedValueOnce(
      JSON.stringify({ model: { provider: "b", thinking: false, reasoningEffort: "high" } }),
    );
    invalidateUserConfigCache();

    const fresh = await loadUserConfig();
    expect(fresh.model.provider).toBe("b");
    expect(fresh.model.thinking).toBe(false);
    expect(mockReadDemo).toHaveBeenCalledTimes(2);
  });

  it("falls back to defaults when the config file is missing", async () => {
    const { loadUserConfig, invalidateUserConfigCache } = await loadDemoLoader();
    mockReadDemo.mockResolvedValueOnce(null);

    const config = await loadUserConfig();
    expect(config.model.provider).toBeTruthy(); // merged defaults, not a throw

    invalidateUserConfigCache();
  });
});
