import { describe, it, expect } from "vitest";
import {
  extractThinkIds,
  extractThinkQuestions,
} from "@/app/api/chat/turn-workflow";
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

function assistantToolCallMsg(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
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

describe("extractThinkQuestions", () => {
  it("collects question strings from thinkDeep tool-calls", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { question: "What's the best approach?" }),
      assistantToolCallMsg("t2", "thinkDeep", { question: "Compare options A and B", effort: "high" }),
    ];
    expect(extractThinkQuestions(messages)).toEqual([
      "What's the best approach?",
      "Compare options A and B",
    ]);
  });

  it("ignores non-thinkDeep tool-calls", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "recall", { query: "rust" }),
      assistantToolCallMsg("t2", "thinkDeep", { question: "real question" }),
    ];
    expect(extractThinkQuestions(messages)).toEqual(["real question"]);
  });

  it("skips thinkDeep calls without a question string", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { effort: "low" }),
      assistantToolCallMsg("t2", "thinkDeep", { question: 42 }),
    ];
    expect(extractThinkQuestions(messages)).toEqual([]);
  });

  it("returns an empty list when there are no assistant messages", () => {
    expect(extractThinkQuestions([])).toEqual([]);
  });

  it("ignores tool RESULT messages (questions live in assistant tool-calls)", () => {
    const messages: ModelMessage[] = [
      toolResultMsg("t1", "thinkDeep", { value: { ok: true, thinkId: "think-1" } }),
    ];
    expect(extractThinkQuestions(messages)).toEqual([]);
  });
});
