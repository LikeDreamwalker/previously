/**
 * Bridge brain gating — the `bridge/<agent>` model entries exist ONLY in
 * client mode with PREVIOUSLY_BRAIN=bridge (pure subscription mode, no API
 * keys). Cloud mode and key-configured clients must be byte-for-byte
 * unaffected. All three agent CLIs register as selectable models; the
 * env-selected agent is the default (its entry comes first).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Worker resolution loads the user config — stub the loader (no config I/O).
const loader = vi.hoisted(() => ({ loadUserConfig: vi.fn() }));
vi.mock("@/lib/config/loader", () => ({ loadUserConfig: loader.loadUserConfig }));

import {
  BRIDGE_AGENTS,
  bridgeAgentFromModelId,
  getAvailableModels,
  getBridgeAgent,
  getBridgeModel,
  getBridgeModels,
  getDefaultModelId,
  getModel,
  isBridgeBrainActive,
} from "@/lib/models/registry";
import { __resetCatalogCache, resolveAvailableModels } from "@/lib/models/catalog";
import { resolveWorkerModel } from "@/lib/models/worker";

const SAVED_ENV = { ...process.env };

/** Every env var these tests touch. */
const ENV_KEYS = [
  "PREVIOUSLY_MODE",
  "PREVIOUSLY_BRAIN",
  "PREVIOUSLY_BRAIN_AGENT",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetCatalogCache();
}

function activateBridge(agent?: string) {
  process.env.PREVIOUSLY_MODE = "client";
  process.env.PREVIOUSLY_BRAIN = "bridge";
  if (agent) process.env.PREVIOUSLY_BRAIN_AGENT = agent;
  __resetCatalogCache();
}

beforeEach(() => {
  clearEnv();
  loader.loadUserConfig.mockResolvedValue({ worker: { mode: "auto", provider: "" } });
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  __resetCatalogCache();
});

describe("isBridgeBrainActive / getBridgeAgent", () => {
  it("is inactive by default (cloud mode, no env)", () => {
    expect(isBridgeBrainActive()).toBe(false);
    expect(getBridgeModel()).toBeUndefined();
    expect(getBridgeModels()).toEqual([]);
  });

  it("is inactive in cloud mode even with PREVIOUSLY_BRAIN=bridge set", () => {
    process.env.PREVIOUSLY_BRAIN = "bridge";
    process.env.PREVIOUSLY_BRAIN_AGENT = "kimi";
    expect(isBridgeBrainActive()).toBe(false);
    expect(getBridgeModels()).toEqual([]);
  });

  it("is inactive in client mode without PREVIOUSLY_BRAIN (API-key client)", () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.DEEPSEEK_API_KEY = "sk-test";
    expect(isBridgeBrainActive()).toBe(false);
    expect(getBridgeModels()).toEqual([]);
  });

  it("is active only in client mode with PREVIOUSLY_BRAIN=bridge", () => {
    activateBridge();
    expect(isBridgeBrainActive()).toBe(true);
    expect(getBridgeModel()?.id).toBe("bridge/claude");
  });

  it("honors PREVIOUSLY_BRAIN_AGENT and falls back to claude on unknown values", () => {
    activateBridge("kimi");
    expect(getBridgeAgent()).toBe("kimi");
    expect(getBridgeModel()?.id).toBe("bridge/kimi");

    activateBridge("not-an-agent");
    expect(getBridgeAgent()).toBe("claude");
    expect(getBridgeModel()?.id).toBe("bridge/claude");
  });
});

describe("getBridgeModels (one entry per agent CLI)", () => {
  it("registers all three agents, env-selected agent first", () => {
    activateBridge("codex");
    const models = getBridgeModels();
    expect(models.map((m) => m.id)).toEqual([
      "bridge/codex",
      "bridge/claude",
      "bridge/kimi",
    ]);
    for (const m of models) {
      expect(m.provider).toBe("bridge");
      expect(m.sdk).toBe("bridge");
      expect(m.capabilities.thinking).toBe(false);
    }
  });

  it("defaults to claude first when PREVIOUSLY_BRAIN_AGENT is unset", () => {
    activateBridge();
    expect(getBridgeModels().map((m) => m.id)).toEqual(
      BRIDGE_AGENTS.map((a) => `bridge/${a}`),
    );
  });
});

describe("bridgeAgentFromModelId", () => {
  it("parses the agent from bridge/<agent> ids", () => {
    expect(bridgeAgentFromModelId("bridge/claude")).toBe("claude");
    expect(bridgeAgentFromModelId("bridge/codex")).toBe("codex");
    expect(bridgeAgentFromModelId("bridge/kimi")).toBe("kimi");
  });

  it("falls back to the env-selected agent for bare/unknown/non-bridge ids", () => {
    activateBridge("kimi");
    expect(bridgeAgentFromModelId("bridge")).toBe("kimi");
    expect(bridgeAgentFromModelId("bridge/not-an-agent")).toBe("kimi");
    expect(bridgeAgentFromModelId("deepseek-v4-flash")).toBe("kimi");

    // Without the env pair, the fallback is the default agent (claude).
    clearEnv();
    expect(bridgeAgentFromModelId("bridge/not-an-agent")).toBe("claude");
  });
});

describe("registry integration", () => {
  it("bridge models appear in getAvailableModels only when the brain is active", () => {
    expect(getAvailableModels().some((m) => m.provider === "bridge")).toBe(false);

    activateBridge("codex");
    const bridges = getAvailableModels().filter((m) => m.provider === "bridge");
    expect(bridges.map((m) => m.id)).toEqual([
      "bridge/codex",
      "bridge/claude",
      "bridge/kimi",
    ]);
  });

  it("getModel resolves every bridge id only when active", () => {
    expect(getModel("bridge/claude")).toBeUndefined();
    activateBridge();
    expect(getModel("bridge/claude")?.provider).toBe("bridge");
    // Every agent's id resolves, not just the env-selected one.
    expect(getModel("bridge/codex")?.sdk).toBe("bridge");
    expect(getModel("bridge/kimi")?.provider).toBe("bridge");
  });

  it("makes the env-selected agent the default when no API-key model is available", () => {
    activateBridge("kimi");
    expect(getDefaultModelId()).toBe("bridge/kimi");
  });

  it("keeps an API-key model as the default when one is available", () => {
    activateBridge();
    process.env.DEEPSEEK_API_KEY = "sk-test";
    expect(getDefaultModelId()).toBe("deepseek-v4-flash");
  });

  it("appears in the dynamic catalog (drives /api/models and id resolution)", async () => {
    activateBridge("codex");
    const models = await resolveAvailableModels();
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["bridge/claude", "bridge/codex", "bridge/kimi"]),
    );

    clearEnv();
    const cloudModels = await resolveAvailableModels();
    expect(cloudModels.some((m) => m.provider === "bridge")).toBe(false);
  });
});

describe("worker tier in pure subscription mode", () => {
  it("follows the single brain switch — the worker IS the bridge main model", async () => {
    activateBridge();
    const main = getModel("bridge/claude");
    expect(main).toBeDefined();
    const worker = await resolveWorkerModel(main);
    // Bridge mode has no separate worker configuration: housekeeping/recall/
    // evolution run on the same bridge model as the main chat (each call is a
    // CLI subprocess on the user's subscription quota — no cheap tier exists).
    expect(worker.sdk).toBe("bridge");
    expect(worker).toBe(main);
  });

  it("still honors an explicit manual pin in bridge mode (the escape hatch)", async () => {
    activateBridge();
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    loader.loadUserConfig.mockResolvedValue({
      worker: { mode: "manual", provider: "claude-opus-4-8" },
    });
    const worker = await resolveWorkerModel(getModel("bridge/claude"));
    expect(worker.id).toBe("claude-opus-4-8");
  });

  it("honors a manual pin to another bridge agent in bridge mode", async () => {
    activateBridge("claude");
    loader.loadUserConfig.mockResolvedValue({
      worker: { mode: "manual", provider: "bridge/kimi" },
    });
    const worker = await resolveWorkerModel(getModel("bridge/claude"));
    expect(worker.id).toBe("bridge/kimi");
  });
});
