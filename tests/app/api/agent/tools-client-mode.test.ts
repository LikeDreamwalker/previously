/**
 * Client-mode tool gating: the subscription-bridge dispatch tool (and its
 * context entry) exist only when PREVIOUSLY_MODE=client.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  chatTools,
  getChatTools,
  buildChatToolsContext,
} from "@/app/api/agent/tools";
import type { ToolContext } from "@/app/api/agent/tool-executors";

const SAVED_MODE = process.env.PREVIOUSLY_MODE;

afterEach(() => {
  if (SAVED_MODE === undefined) delete process.env.PREVIOUSLY_MODE;
  else process.env.PREVIOUSLY_MODE = SAVED_MODE;
});

const ctx: ToolContext = {
  repo: "local",
  owner: "local",
  useGithub: false,
  useDemo: false,
  sliceId: "2026-08-19-1400",
  recentTurns: [],
};

describe("client-mode tool gating", () => {
  it("cloud mode: delegateTask is absent from the chat tool set", () => {
    delete process.env.PREVIOUSLY_MODE;
    const tools = getChatTools();
    expect(tools).not.toHaveProperty("delegateTask");
    expect(Object.keys(tools)).toEqual(Object.keys(chatTools));
    expect(buildChatToolsContext(ctx)).not.toHaveProperty("delegateTask");
  });

  it("client mode: delegateTask is registered with a context entry", () => {
    process.env.PREVIOUSLY_MODE = "client";
    const tools = getChatTools();
    expect(tools).toHaveProperty("delegateTask");
    for (const name of Object.keys(chatTools)) {
      expect(tools).toHaveProperty(name);
    }
    const contexts = buildChatToolsContext(ctx);
    expect(contexts.delegateTask).toBe(ctx);
  });
});

describe("toolContextSchema — step-boundary round-trip", () => {
  it("keeps timezone / startedAtIso / locale through the schema re-parse (zod strips undeclared keys)", async () => {
    const { toolContextSchema } = await import("@/app/api/agent/tools");
    const full: ToolContext = {
      ...ctx,
      timezone: "Asia/Shanghai",
      startedAtIso: "2026-08-28T07:39:01.339Z",
      locale: "zh",
    };
    const parsed = toolContextSchema.parse(full);
    expect(parsed.timezone).toBe("Asia/Shanghai");
    expect(parsed.startedAtIso).toBe("2026-08-28T07:39:01.339Z");
    expect(parsed.locale).toBe("zh");
  });
});
