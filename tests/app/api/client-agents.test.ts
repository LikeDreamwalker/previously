/**
 * /api/client/agents — client-mode-only local agent detection endpoint.
 * Mode gating (cloud → 404) and response shape; the detection itself is
 * mocked so the test never probes the developer's real PATH.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET as agentsGET } from "@/app/api/client/agents/route";
import { detectLocalAgents } from "@/lib/client-detect";

vi.mock("@/lib/client-detect", () => ({
  detectLocalAgents: vi.fn(),
}));

const mockedDetect = vi.mocked(detectLocalAgents);

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  process.env.PREVIOUSLY_MODE = "client";
  mockedDetect.mockResolvedValue([
    { name: "claude", found: true, path: "/usr/local/bin/claude", version: "claude 2.1.0" },
    { name: "codex", found: false },
    { name: "kimi", found: true, path: "/home/x/bin/kimi" },
  ]);
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  mockedDetect.mockReset();
});

describe("GET /api/client/agents", () => {
  it("is 404 in cloud mode and never probes", async () => {
    delete process.env.PREVIOUSLY_MODE;
    const res = await agentsGET();
    expect(res.status).toBe(404);
    expect(mockedDetect).not.toHaveBeenCalled();
  });

  it("returns the detection result in client mode", async () => {
    const res = await agentsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([
      { name: "claude", found: true, path: "/usr/local/bin/claude", version: "claude 2.1.0" },
      { name: "codex", found: false },
      { name: "kimi", found: true, path: "/home/x/bin/kimi" },
    ]);
  });
});
