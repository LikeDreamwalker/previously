/**
 * delegateTaskExecute — subscription bridge dispatch (client mode only).
 * Spawns fixture node scripts as the fake bridge command; every failure path
 * must surface as a structured error result, never a fake success.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  delegateTaskExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

/** Quote both segments — node may live in a path with spaces. */
function bridgeCmd(fixture: string): string {
  return `"${process.execPath}" "${join(FIXTURES, fixture)}"`;
}

const SAVED_ENV = {
  cmd: process.env.PREVIOUSLY_BRIDGE_CMD,
  timeout: process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS,
};

beforeEach(() => {
  delete process.env.PREVIOUSLY_BRIDGE_CMD;
  delete process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS;
});

afterAll(() => {
  if (SAVED_ENV.cmd === undefined) delete process.env.PREVIOUSLY_BRIDGE_CMD;
  else process.env.PREVIOUSLY_BRIDGE_CMD = SAVED_ENV.cmd;
  if (SAVED_ENV.timeout === undefined)
    delete process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS;
  else process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS = SAVED_ENV.timeout;
});

function opts(): { context: ToolContext; toolCallId: string } {
  return {
    context: {
      repo: "local",
      owner: "local",
      useGithub: false,
      useDemo: false,
      sliceId: "2026-08-19-1400",
      recentTurns: [],
    },
    toolCallId: "tc-bridge",
  };
}

describe("delegateTaskExecute", () => {
  it("returns the bridge stdout as the result on exit 0", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const out = await delegateTaskExecute(
      { task: "summarize notes", context: "some context" },
      opts(),
    );
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.result).toBe("ok:summarize notes|ctx:some context");
    }
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces a non-zero exit with the stderr tail", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-fail.mjs");
    const out = await delegateTaskExecute({ task: "anything" }, opts());
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.reason).toBe("exit-code");
      expect(out.error).toContain("code 3");
      expect(out.error).toContain("bridge exploded");
    }
  });

  it("surfaces a missing bridge binary as bridge-not-found", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD =
      "previously-bridge-definitely-not-installed-xyz bridge-exec";
    const out = await delegateTaskExecute({ task: "anything" }, opts());
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.reason).toBe("bridge-not-found");
      expect(out.error).toContain("previously-bridge-definitely-not-installed-xyz");
    }
  });

  it("times out a hanging bridge and reports it honestly", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-hang.mjs");
    process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS = "300";
    const out = await delegateTaskExecute({ task: "anything" }, opts());
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.reason).toBe("timeout");
      expect(out.error).toContain("300ms");
    }
  });

  it("treats exit 0 with empty stdout as malformed output", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-empty.mjs");
    const out = await delegateTaskExecute({ task: "anything" }, opts());
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.reason).toBe("empty-output");
    }
  });
});
