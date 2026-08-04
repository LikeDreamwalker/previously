import { describe, it, expect } from "vitest";
import { extractThinkIds } from "@/app/api/chat/turn-workflow";
import type { ModelMessage } from "ai";

function toolResultMsg(
  toolCallId: string,
  toolName: string,
  output: unknown,
): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output }],
  } as ModelMessage;
}

describe("extractThinkIds", () => {
  it("collects thinkIds from successful thinkDeep tool results", () => {
    const messages: ModelMessage[] = [
      toolResultMsg("t1", "thinkDeep", { value: { ok: true, thinkId: "think-1", status: "dispatched" } }),
      toolResultMsg("t2", "thinkDeep", { value: { ok: true, thinkId: "think-2", status: "dispatched" } }),
    ];
    expect(extractThinkIds(messages)).toEqual(["think-1", "think-2"]);
  });

  it("skips failed dispatches (ok: false)", () => {
    const messages: ModelMessage[] = [
      toolResultMsg("t1", "thinkDeep", { value: { ok: false, error: "no repo" } }),
    ];
    expect(extractThinkIds(messages)).toEqual([]);
  });

  it("ignores unrelated tool results", () => {
    const messages: ModelMessage[] = [
      toolResultMsg("t1", "startLoop", { value: { ok: true, loopId: "loop-1" } }),
    ];
    expect(extractThinkIds(messages)).toEqual([]);
  });

  it("returns an empty list when there are no tool messages", () => {
    expect(extractThinkIds([])).toEqual([]);
  });
});
