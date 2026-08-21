/**
 * /api/models — bridge options carry `hint` + `available` in pure
 * subscription mode (client + PREVIOUSLY_BRAIN=bridge); non-bridge options
 * never do. The catalog and PATH detection are mocked so the test never
 * probes the developer's machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET as modelsGET } from "@/app/api/models/route";
import { resolveAvailableModels } from "@/lib/models/catalog";
import { detectLocalAgents } from "@/lib/client-detect";
import type { ModelConfig } from "@/lib/models/registry";

vi.mock("@/lib/models/catalog", () => ({
  resolveAvailableModels: vi.fn(),
}));
vi.mock("@/lib/client-detect", () => ({
  detectLocalAgents: vi.fn(),
}));

const mockedCatalog = vi.mocked(resolveAvailableModels);
const mockedDetect = vi.mocked(detectLocalAgents);

const SAVED_ENV = { ...process.env };

function bridgeConfig(agent: string): ModelConfig {
  return {
    id: `bridge/${agent}`,
    name: `${agent} (subscription bridge)`,
    provider: "bridge",
    providerName: "Subscription Bridge",
    sdk: "bridge",
    envKey: "PREVIOUSLY_BRAIN",
    capabilities: { thinking: false, vision: false, maxTokens: 200_000 },
    defaultThinking: false,
    defaultEffort: "low",
  };
}

const API_MODEL: ModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: true,
  defaultEffort: "low",
};

beforeEach(() => {
  delete process.env.PREVIOUSLY_MODE;
  delete process.env.PREVIOUSLY_BRAIN;
  mockedCatalog.mockResolvedValue([API_MODEL]);
  mockedDetect.mockResolvedValue([
    { name: "claude", found: true, path: "/usr/local/bin/claude" },
    { name: "codex", found: false },
    { name: "kimi", found: true, path: "/home/x/bin/kimi" },
  ]);
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  mockedCatalog.mockReset();
  mockedDetect.mockReset();
});

describe("GET /api/models", () => {
  it("omits hint/available when no bridge brain is active", async () => {
    const res = await modelsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).not.toHaveProperty("hint");
    expect(body.models[0]).not.toHaveProperty("available");
    expect(mockedDetect).not.toHaveBeenCalled();
  });

  it("adds hint/available to bridge options in pure subscription mode", async () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    mockedCatalog.mockResolvedValue([
      bridgeConfig("claude"),
      bridgeConfig("codex"),
      bridgeConfig("kimi"),
      API_MODEL,
    ]);

    const res = await modelsGET();
    const body = await res.json();

    const bridges = body.models.filter(
      (m: { provider: string }) => m.provider === "bridge",
    );
    expect(bridges).toHaveLength(3);
    const byId = new Map(bridges.map((m: { id: string }) => [m.id, m]));

    expect(byId.get("bridge/claude")).toMatchObject({
      available: true,
      hint: expect.stringContaining("Claude Code"),
    });
    expect(byId.get("bridge/codex")).toMatchObject({
      available: false,
      hint: expect.stringContaining("Codex"),
    });
    expect(byId.get("bridge/kimi")).toMatchObject({
      available: true,
      hint: expect.stringContaining("Kimi"),
    });

    // Non-bridge options never carry the bridge-only fields.
    const api = body.models.find(
      (m: { provider: string }) => m.provider === "deepseek",
    );
    expect(api).not.toHaveProperty("hint");
    expect(api).not.toHaveProperty("available");
  });
});
