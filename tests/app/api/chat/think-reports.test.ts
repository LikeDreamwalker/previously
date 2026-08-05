import { describe, it, expect } from "vitest";
import { extractThinkDeepReports } from "@/app/api/chat/turn-workflow";
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

describe("extractThinkDeepReports", () => {
  it("matches each tool-call question with its answer and reasoning", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { question: "Verify claim A" }),
      assistantToolCallMsg("t2", "thinkDeep", { question: "Weigh option B" }),
      toolResultMsg("t1", "thinkDeep", {
        value: {
          ok: true,
          answer: "## Conclusion\nA holds.",
          reasoning: "Reasoning about A…",
        },
      }),
      toolResultMsg("t2", "thinkDeep", {
        value: {
          ok: true,
          answer: "## Conclusion\nB is risky.",
          reasoning: "Reasoning about B…",
        },
      }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([
      {
        question: "Verify claim A",
        answer: "## Conclusion\nA holds.",
        reasoning: "Reasoning about A…",
      },
      {
        question: "Weigh option B",
        answer: "## Conclusion\nB is risky.",
        reasoning: "Reasoning about B…",
      },
    ]);
  });

  it("skips failed dispatches with no output (ok: false, no answer/reasoning)", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { question: "Q1" }),
      toolResultMsg("t1", "thinkDeep", { value: { ok: false, error: "failed" } }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([]);
  });

  it("preserves an interrupted fragment's partial answer + reasoning (timeout shape)", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { question: "Q1" }),
      toolResultMsg("t1", "thinkDeep", {
        value: {
          ok: false,
          status: "timeout",
          error: "Reasoning fragment did not finish within 280s",
          answer: "## Partial\nSo far…",
          reasoning: "Thinking trail up to the cutoff…",
          note: "You decide what to do next",
        },
      }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([
      {
        question: "Q1",
        answer: "## Partial\nSo far…",
        reasoning: "Thinking trail up to the cutoff…",
      },
    ]);
  });

  it("keeps a fragment that produced only reasoning (empty answer)", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { question: "Q1" }),
      toolResultMsg("t1", "thinkDeep", {
        value: {
          ok: false,
          status: "timeout",
          answer: "",
          reasoning: "Thought it through but was cut before writing…",
        },
      }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([
      {
        question: "Q1",
        answer: "",
        reasoning: "Thought it through but was cut before writing…",
      },
    ]);
  });

  it("skips results with both empty answer and empty reasoning", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "thinkDeep", { question: "Q1" }),
      toolResultMsg("t1", "thinkDeep", { value: { ok: true, answer: "   " } }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([]);
  });

  it("returns an empty array when there are no thinkDeep calls", () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg("t1", "recall", { query: "rust" }),
      toolResultMsg("t1", "recall", { value: { hits: [], confidence: 0 } }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([]);
  });

  it("uses an empty question when the tool-call has no matching question", () => {
    const messages: ModelMessage[] = [
      toolResultMsg("t1", "thinkDeep", {
        value: { ok: true, answer: "answer without a question" },
      }),
    ];
    expect(extractThinkDeepReports(messages)).toEqual([
      {
        question: "",
        answer: "answer without a question",
        reasoning: "",
      },
    ]);
  });
});
