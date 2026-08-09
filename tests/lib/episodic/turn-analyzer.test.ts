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
        message_tags: {
          reuse: ["rust"],
          create: [{ tag: "loop", reason: "no existing topic covers loops" }],
        },
        semantic_hint: { strands: ["rust"], reason: "user mentioned borrow-checker" },
        intent: { type: "code_debug", reason: "user is debugging a failing loop" },
        memory_worthy: true,
        emotional_signal: { intensity: "strong", register: "frustrated", note: "user is frustrated" },
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

    expect(result.messageTags).toEqual({
      reuse: ["rust"],
      create: [{ tag: "loop", reason: "no existing topic covers loops" }],
    });
    expect(result.semanticHint).toEqual({
      strands: ["rust"],
      reason: "user mentioned borrow-checker",
    });
    expect(result.intent).toEqual({
      type: "code_debug",
      reason: "user is debugging a failing loop",
    });
    expect(result.memoryWorthy).toBe(true);
    expect(result.emotionalSignal).toEqual({
      intensity: "strong",
      register: "frustrated",
      note: "user is frustrated",
    });
    expect(result.closedMarking).toEqual({
      focus: "Rust loop tests",
      summary: "Debugged failures",
      tags: ["rust", "testing"],
      tone: "mixed",
    });
  });

  it("passes through memory_worthy for a trivial turn", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "你好", existingStrandNames: [] });
    expect(result.memoryWorthy).toBe(false);
  });

  it("extracts an explicit memory update request", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "user asked to record a preference" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "excited", note: "user is happy" },
        memory_update: { content: "User prefers answers in Chinese from now on", section: "profile" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "记住：以后都用中文回答", existingStrandNames: [] });
    expect(result.memoryUpdate).toEqual({
      content: "User prefers answers in Chinese from now on",
      section: "profile",
    });
  });

  it("omits memory_update when the user did not explicitly ask", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "你好", existingStrandNames: [] });
    expect(result.memoryUpdate).toBeUndefined();
  });

  it("omits closed marking when no slice is closing", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.closedMarking).toBeUndefined();
    expect(result.memoryWorthy).toBe(false);
  });

  it("parses the emotional register and normalizes a missing register to neutral", async () => {
    ai.generateText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "user is venting" },
        memory_worthy: false,
        emotional_signal: { intensity: "strong", note: "venting about a rough week" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "今天太难了", existingStrandNames: [] });
    expect(result.emotionalSignal).toEqual({
      intensity: "strong",
      register: "neutral",
      note: "venting about a rough week",
    });
  });

  it("returns an empty analysis when the model fails", async () => {
    ai.generateText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result).toEqual({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
    });
  });

  it("returns an empty analysis when the tool call is missing", async () => {
    ai.generateText.mockResolvedValue({ toolCalls: [] });
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.messageTags).toEqual({ reuse: [], create: [] });
  });
});
