/**
 * /api/client/status + /api/client/config — client-mode-only endpoints.
 * Mode gating (cloud → 404), config read/write against a temp PREVIOUSLY_HOME,
 * and validation of the executionBackend / brain fields.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as statusGET } from "@/app/api/client/status/route";
import {
  GET as configGET,
  POST as configPOST,
} from "@/app/api/client/config/route";
import { __resetCatalogCache } from "@/lib/models/catalog";

const SAVED_ENV = { ...process.env };
let home: string;

function post(body: unknown): Request {
  // Same-origin browser-shaped POST so the origin guard passes.
  return new Request("http://localhost:3000/api/client/config", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "previously-home-"));
  process.env.PREVIOUSLY_MODE = "client";
  process.env.PREVIOUSLY_HOME = home;
  delete process.env.PREVIOUSLY_BRAIN;
  delete process.env.PREVIOUSLY_BRAIN_AGENT;
  delete process.env.PREVIOUSLY_BRIDGE_CMD;
  delete process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS;
  delete process.env.MEMORY_ROOT;
  __resetCatalogCache();
});

afterEach(async () => {
  process.env = { ...SAVED_ENV };
  __resetCatalogCache();
  await rm(home, { recursive: true, force: true });
});

describe("mode gating", () => {
  it("status is 404 in cloud mode", async () => {
    delete process.env.PREVIOUSLY_MODE;
    const res = await statusGET();
    expect(res.status).toBe(404);
  });

  it("config GET/POST are 404 in cloud mode", async () => {
    delete process.env.PREVIOUSLY_MODE;
    expect((await configGET()).status).toBe(404);
    expect((await configPOST(post({ executionBackend: "local" }))).status).toBe(404);
  });
});

describe("GET /api/client/status", () => {
  it("reports mode, version, home, memory root and the bridge env contract", async () => {
    process.env.PREVIOUSLY_BRAIN = "bridge";
    process.env.PREVIOUSLY_BRAIN_AGENT = "codex";
    const res = await statusGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("client");
    expect(typeof body.version).toBe("string");
    expect(body.home).toBe(home);
    expect(typeof body.memoryRoot).toBe("string");
    expect(body.bridge).toMatchObject({
      cmd: "previously bridge-exec",
      agent: "codex",
      active: true,
      timeoutMs: 600_000,
    });
    // The bridge model is listed when the brain is active.
    expect(body.models.some((m: { id: string }) => m.id === "bridge/codex")).toBe(true);
  });

  it("reports null fields honestly when PREVIOUSLY_HOME is missing", async () => {
    delete process.env.PREVIOUSLY_HOME;
    const body = await (await statusGET()).json();
    expect(body.home).toBeNull();
    expect(body.bridge.active).toBe(false);
    expect(body.bridge.agent).toBeNull();
    expect(body.models.some((m: { provider: string }) => m.provider === "bridge")).toBe(false);
  });
});

describe("GET /api/client/config", () => {
  it("reports exists:false when config.json is missing", async () => {
    const body = await (await configGET()).json();
    expect(body).toMatchObject({
      home,
      exists: false,
      executionBackend: null,
      brain: null,
    });
  });

  it("reads executionBackend and brain from an existing config.json", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        storage: "local",
        memoryRoot: "C:/data/memory",
        executionBackend: "local",
        brain: { type: "bridge", agent: "kimi" },
        apiKeys: { DEEPSEEK_API_KEY: "sk-secret" },
      }),
    );
    const body = await (await configGET()).json();
    expect(body.exists).toBe(true);
    expect(body.executionBackend).toBe("local");
    expect(body.brain).toEqual({ type: "bridge", agent: "kimi" });
    // apiKeys must never leave the server through this endpoint.
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("reads the byok section (plaintext apiKey — local single-user state)", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        byok: { provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" },
      }),
    );
    const body = await (await configGET()).json();
    expect(body.byok).toEqual({
      provider: "deepseek",
      apiKey: "sk-byok",
      model: "deepseek-chat",
    });
  });

  it("surfaces a corrupt config.json as an honest 500", async () => {
    await writeFile(join(home, "config.json"), "{ not json");
    const res = await configGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("config.json");
  });
});

describe("POST /api/client/config", () => {
  it("writes executionBackend + brain, preserving unmanaged fields", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ storage: "local", port: 3737, executionBackend: null }),
    );
    const res = await configPOST(
      post({
        executionBackend: "docker",
        brain: { type: "api-key", env: "DEEPSEEK_API_KEY", model: "deepseek-v4-pro" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executionBackend).toBe("docker");
    expect(body.brain).toEqual({
      type: "api-key",
      env: "DEEPSEEK_API_KEY",
      model: "deepseek-v4-pro",
    });

    // The file on disk kept the unmanaged fields.
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.storage).toBe("local");
    expect(onDisk.port).toBe(3737);
    expect(onDisk.brain.type).toBe("api-key");
  });

  it("creates config.json (and the home dir) when missing", async () => {
    await rm(home, { recursive: true, force: true });
    const res = await configPOST(post({ brain: { type: "bridge", agent: "claude" } }));
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.brain).toEqual({ type: "bridge", agent: "claude" });
  });

  it("clears fields with explicit null", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ executionBackend: "local", brain: { type: "bridge", agent: "kimi" } }),
    );
    const res = await configPOST(post({ executionBackend: null, brain: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executionBackend).toBeNull();
    expect(body.brain).toBeNull();
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.executionBackend).toBeNull();
    expect("brain" in onDisk).toBe(false);
  });

  it("writes per-agent params and surfaces them in the snapshot", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ storage: "local", apiKeys: { X: "sk-secret" } }),
    );
    const res = await configPOST(
      post({
        agents: {
          claude: { model: "claude-opus-4-8", effort: "high" },
          kimi: { model: "kimi-for-coding" },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual({
      claude: { model: "claude-opus-4-8", effort: "high" },
      kimi: { model: "kimi-for-coding" },
    });
    // Unmanaged fields are preserved; secrets never leave the server.
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.storage).toBe("local");
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("leaves agents unchanged when the patch omits it (tri-state)", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ agents: { codex: { model: "gpt-5.4", effort: "low" } } }),
    );
    const res = await configPOST(post({ executionBackend: "local" }));
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.agents).toEqual({ codex: { model: "gpt-5.4", effort: "low" } });
  });

  it("clears agents with explicit null", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ agents: { claude: { model: "claude-opus-4-8" } } }),
    );
    const res = await configPOST(post({ agents: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).agents).toBeNull();
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect("agents" in onDisk).toBe(false);
  });

  it("rejects invalid agents values with a 400 and writes nothing", async () => {
    for (const agents of [
      "claude",
      { gpt: { model: "x" } }, // unknown agent
      { claude: "opus" }, // non-object entry
      { claude: { model: "" } }, // empty model
      { claude: { model: 42 } }, // non-string model
      { claude: { effort: "max" } }, // bad effort enum
      { kimi: { effort: "low" } }, // kimi has no effort knob
      { codex: { thinking: true } }, // unsupported field
    ]) {
      const res = await configPOST(post({ agents }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    const res = await configGET();
    expect((await res.json()).exists).toBe(false);
  });

  it("rejects invalid values with a 400 and writes nothing", async () => {
    for (const bad of [
      { executionBackend: "" },
      { executionBackend: 42 },
      { brain: { type: "bridge", agent: "gpt" } },
      { brain: { type: "api-key" } },
      { brain: { type: "other" } },
      { brain: "bridge" },
    ]) {
      const res = await configPOST(post(bad));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    // No file was created by any of the rejected writes.
    const res = await configGET();
    expect((await res.json()).exists).toBe(false);
  });

  it("rejects an empty patch and non-object bodies", async () => {
    expect((await configPOST(post({}))).status).toBe(400);
    const res = await configPOST(
      new Request("http://localhost:3000/api/client/config", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("fails honestly when PREVIOUSLY_HOME is not set", async () => {
    delete process.env.PREVIOUSLY_HOME;
    const res = await configPOST(post({ executionBackend: "local" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("PREVIOUSLY_HOME");
  });

  // ── byok (user's own API key) ──

  it("writes a byok section, preserving unmanaged fields", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ storage: "local", brain: { type: "bridge", agent: "claude" } }),
    );
    const res = await configPOST(
      post({ byok: { provider: "deepseek", apiKey: "sk-byok", model: "deepseek-chat" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byok).toEqual({
      provider: "deepseek",
      apiKey: "sk-byok",
      model: "deepseek-chat",
    });
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.storage).toBe("local");
    expect(onDisk.brain).toEqual({ type: "bridge", agent: "claude" });
    expect(onDisk.byok.model).toBe("deepseek-chat");
  });

  it("writes a custom-provider byok with its baseUrl", async () => {
    const res = await configPOST(
      post({
        byok: {
          provider: "custom",
          apiKey: "sk-x",
          baseUrl: "https://llm.example.com/v1",
          model: "my-model",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).byok).toEqual({
      provider: "custom",
      apiKey: "sk-x",
      baseUrl: "https://llm.example.com/v1",
      model: "my-model",
    });
  });

  it("leaves byok unchanged when the patch omits it (tri-state)", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ byok: { provider: "openai", apiKey: "sk-keep", model: "gpt-5.4" } }),
    );
    const res = await configPOST(post({ executionBackend: "local" }));
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.byok).toEqual({ provider: "openai", apiKey: "sk-keep", model: "gpt-5.4" });
  });

  it("clears byok with explicit null", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ byok: { provider: "openai", apiKey: "sk-x", model: "gpt-5.4" } }),
    );
    const res = await configPOST(post({ byok: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).byok).toBeNull();
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect("byok" in onDisk).toBe(false);
  });

  it("rejects invalid byok values with a 400 and writes nothing", async () => {
    for (const byok of [
      "deepseek", // non-object
      {}, // everything missing
      { provider: "deepseek", apiKey: "sk", model: "" }, // empty model
      { provider: "deepseek", model: "m" }, // missing apiKey
      { apiKey: "sk", model: "m" }, // missing provider
      { provider: "custom", apiKey: "sk", model: "m" }, // custom without baseUrl
      { provider: "not-a-provider", apiKey: "sk", model: "m" }, // unknown provider
      { provider: "deepseek", apiKey: "sk", model: "m", region: "cn" }, // unknown field
    ]) {
      const res = await configPOST(post({ byok }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    const res = await configGET();
    expect((await res.json()).exists).toBe(false);
  });

  it("is blocked by the origin guard for cross-site posts when ACCESS_SECRET is set", async () => {
    process.env.ACCESS_SECRET = "topsecret";
    const res = await configPOST(
      new Request("http://localhost:3000/api/client/config", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ executionBackend: "local" }),
      }),
    );
    expect(res.status).toBe(403);
    delete process.env.ACCESS_SECRET;
  });
});
