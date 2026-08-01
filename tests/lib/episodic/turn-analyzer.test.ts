import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, generateText: ai.generateText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));
vi.mock("@/lib/models/worker", () => ({
  workerProviderOptions: vi.fn(() => ({})),
}));

import { analyzeTurn } from "@/lib/episodic/flash/turn-analyzer";
import type { ModelConfig } from "@/lib/models/registry";

const model: ModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
};

function makeToolCall(input: unknown) {
  return { toolCalls: [{ toolName: "analyzeOutput", input }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analyzeTurn", () => {
  it("parses message tags, semantic hint, intent, and close marking from the tool call", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({
        message_tags: ["rust", "loop"],
        semantic_hint: { strands: ["rust"], reason: "user mentioned borrow-checker" },
        intent: { type: "code_debug", reason: "user is debugging a failing loop" },
        closed_marking: {
          focus: "Rust loop tests",
          summary: "Debugged failures",
          tags: ["rust", "testing"],
          tone: "mixed",
        },
      }),
    );

    const result = await analyzeTurn({
      model,
      userMessage: "rust loop broken",
      existingStrandNames: ["rust", "async"],
      closingSlice: {
        turns: [{ timestamp: "t", role: "user", content: "hi" }],
        tags: ["rust"],
      },
    });

    expect(result.messageTags).toEqual(["rust", "loop"]);
    expect(result.semanticHint).toEqual({
      strands: ["rust"],
      reason: "user mentioned borrow-checker",
    });
    expect(result.intent).toEqual({
      type: "code_debug",
      reason: "user is debugging a failing loop",
    });
    expect(result.closedMarking).toEqual({
      focus: "Rust loop tests",
      summary: "Debugged failures",
      tags: ["rust", "testing"],
      tone: "mixed",
    });
  });

  it("omits closed marking when no slice is closing", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({ message_tags: [], semantic_hint: { strands: [], reason: "" } }),
    );
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.closedMarking).toBeUndefined();
  });

  it("returns an empty analysis when the model fails", async () => {
    ai.generateText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result).toEqual({ messageTags: [], semanticHint: { strands: [], reason: "" } });
  });

  it("returns an empty analysis when the tool call is missing", async () => {
    ai.generateText.mockResolvedValue({ toolCalls: [] });
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.messageTags).toEqual([]);
  });
});
