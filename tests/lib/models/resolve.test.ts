import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      defaultEffort: "low",
    },
  ]),
}));

import {
  resolveModelById,
  resolveMainModelFromConfig,
} from "@/lib/models/resolve";

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

// ─── resolveModelById ───────────────────────────────────────────────────────

describe("resolveModelById", () => {
  it("resolves a curated registry id without touching the catalog", async () => {
    const model = await resolveModelById("deepseek-v4-flash");
    expect(model?.provider).toBe("deepseek");
  });

  it("falls back to the dynamic catalog for uncurated ids", async () => {
    const model = await resolveModelById("kimi-latest");
    expect(model?.provider).toBe("moonshotai");
  });

  it("returns undefined for an unknown id", async () => {
    await expect(resolveModelById("nope")).resolves.toBeUndefined();
  });
});

// ─── resolveMainModelFromConfig ─────────────────────────────────────────────
// Single model: sub-agents run on the SAME main model as the chat — there is
// no worker tier and no manual pin.

describe("resolveMainModelFromConfig", () => {
  it("resolves the configured main model id", async () => {
    loader.loadUserConfig.mockResolvedValue({
      model: { provider: "kimi-latest" },
    });
    const main = await resolveMainModelFromConfig();
    expect(main.id).toBe("kimi-latest");
  });

  it("resolves a bridge main model as-is (single brain switch)", async () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    loader.loadUserConfig.mockResolvedValue({
      model: { provider: "bridge/claude" },
    });
    const main = await resolveMainModelFromConfig();
    expect(main.id).toBe("bridge/claude");
    expect(main.sdk).toBe("bridge");
  });

  it("falls back to the deployment default for an unknown configured id", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    loader.loadUserConfig.mockResolvedValue({
      model: { provider: "nope" },
    });
    const main = await resolveMainModelFromConfig();
    // No provider keys configured → the hardcoded first curated entry.
    expect(main.id).toBe("deepseek-v4-flash");
  });
});
