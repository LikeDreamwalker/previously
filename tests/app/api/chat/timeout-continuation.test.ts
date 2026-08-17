/**
 * Tests for buildTimeoutContinuation (C2) — the timeout-continuation message
 * assembly must carry the interrupted run's completed tool calls + results,
 * not just the partial assistant text.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  buildTimeoutContinuation,
  type ContinuationStepSnapshot,
} from "@/app/api/chat/turn-workflow";

const HISTORY: ModelMessage[] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "what did we decide about the API?" },
];

const NUDGE = "You were interrupted by a timeout. Continue.";

function stepWithTool(): ContinuationStepSnapshot {
  return {
    text: "Let me look that up.",
    toolCalls: [
      { toolCallId: "call_1", toolName: "recall", input: { query: "API decision" } },
    ],
    toolResults: [
      {
        toolCallId: "call_1",
        toolName: "recall",
        output: { hits: [{ slice_id: "2026-08-01-1015" }], confidence: 0.8 },
      },
    ],
  };
}

describe("buildTimeoutContinuation", () => {
  it("includes completed tool call + result before the partial text and nudge", () => {
    const messages = buildTimeoutContinuation({
      history: HISTORY,
      steps: [stepWithTool()],
      partialText: "Let me look that up.",
      nudge: NUDGE,
    });

    expect(messages.slice(0, 2)).toEqual(HISTORY);

    const assistant = messages[2];
    expect(assistant.role).toBe("assistant");
    const callParts = assistant.content as Array<Record<string, unknown>>;
    expect(callParts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "recall",
      input: { query: "API decision" },
    });

    const tool = messages[3];
    expect(tool.role).toBe("tool");
    const resultParts = tool.content as Array<Record<string, unknown>>;
    expect(resultParts[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "recall",
      output: {
        type: "json",
        value: { hits: [{ slice_id: "2026-08-01-1015" }], confidence: 0.8 },
      },
    });

    // Partial assistant text, then the nudge LAST.
    expect(messages[4]).toEqual({
      role: "assistant",
      content: "Let me look that up.",
    });
    expect(messages[5]).toEqual({ role: "user", content: NUDGE });
  });

  it("skips text-only steps for the tool messages (their text lives in partialText)", () => {
    const messages = buildTimeoutContinuation({
      history: HISTORY,
      steps: [{ text: "just text", toolCalls: [], toolResults: [] }],
      partialText: "just text",
      nudge: NUDGE,
    });

    expect(messages).toHaveLength(HISTORY.length + 2);
    expect(messages[messages.length - 2]).toEqual({
      role: "assistant",
      content: "just text",
    });
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: NUDGE });
  });

  it("wraps error tool results as error-text", () => {
    const step: ContinuationStepSnapshot = {
      text: "",
      toolCalls: [
        { toolCallId: "call_9", toolName: "webSearch", input: { q: "x" } },
      ],
      toolResults: [
        {
          toolCallId: "call_9",
          toolName: "webSearch",
          output: "fetch failed",
          isError: true,
        },
      ],
    };
    const messages = buildTimeoutContinuation({
      history: HISTORY,
      steps: [step],
      partialText: "",
      nudge: NUDGE,
    });

    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    const parts = tool!.content as Array<Record<string, unknown>>;
    expect(parts[0].output).toEqual({ type: "error-text", value: "fetch failed" });
    // No partial text → straight from tool result to nudge.
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: NUDGE });
  });

  it("omits tool results whose call is missing (defensive)", () => {
    const step: ContinuationStepSnapshot = {
      text: "",
      toolCalls: [
        { toolCallId: "call_a", toolName: "recall", input: { query: "q" } },
      ],
      toolResults: [
        { toolCallId: "call_OTHER", toolName: "recall", output: {} },
      ],
    };
    const messages = buildTimeoutContinuation({
      history: HISTORY,
      steps: [step],
      partialText: "",
      nudge: NUDGE,
    });

    expect(messages.some((m) => m.role === "tool")).toBe(false);
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("handles an empty interruption (no steps, no text) with just the nudge", () => {
    const messages = buildTimeoutContinuation({
      history: HISTORY,
      steps: [],
      partialText: "",
      nudge: NUDGE,
    });
    expect(messages).toEqual([...HISTORY, { role: "user", content: NUDGE }]);
  });

  it("does not mutate the history array", () => {
    const history = [...HISTORY];
    buildTimeoutContinuation({
      history,
      steps: [stepWithTool()],
      partialText: "x",
      nudge: NUDGE,
    });
    expect(history).toEqual(HISTORY);
  });
});
