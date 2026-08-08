import { describe, it, expect } from "vitest";
import { suggestMemoryUpdateExecute } from "@/app/api/agent/tool-executors";
import type { ToolContext } from "@/app/api/agent/tool-executors";

const ctx = {} as ToolContext;

describe("suggestMemoryUpdateExecute", () => {
  it("returns a passive pending marker and never writes memory", async () => {
    const res = await suggestMemoryUpdateExecute(
      { summary: "  User prefers concise answers  " },
      { context: ctx, toolCallId: "tc-1" },
    );
    expect(res).toEqual({
      ok: true,
      status: "pending",
      summary: "User prefers concise answers",
    });
  });

  it("normalizes an empty summary", async () => {
    const res = await suggestMemoryUpdateExecute(
      { summary: "   " },
      { context: ctx, toolCallId: "tc-2" },
    );
    expect(res.summary).toBe("");
    expect(res.ok).toBe(true);
  });
});
