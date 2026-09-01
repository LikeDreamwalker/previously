import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({
  streamText: vi.fn(),
  // Records the runner's step cap (stopWhen: isStepCount(maxSteps)) so the
  // anti-loop fuse value is assertable.
  isStepCount: vi.fn((n: number) => ({ __stepCount: n })),
}));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText, isStepCount: ai.isStepCount };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

import { analyzeTurn, shouldRunCardEvolution } from "@/lib/episodic/flash/turn-analyzer";
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

/** A StreamTextResult stand-in resolving to the given report tool call. */
function makeToolCall(input: unknown) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolName: "analyzeOutput", input }]),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

/** A StreamTextResult stand-in with no tool calls at all. */
function noToolCall() {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analyzeTurn", () => {
  it("parses message tags, semantic hint, intent, and close marking from the tool call", async () => {
    ai.streamText.mockResolvedValue(
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
    ai.streamText.mockResolvedValue(
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
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "user asked to record a preference" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "excited", note: "user is happy" },
        memory_update: { content: "User prefers answers in Chinese from now on", section: "past" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "记住：以后都用中文回答", existingStrandNames: [] });
    expect(result.memoryUpdate).toEqual({
      content: "User prefers answers in Chinese from now on",
      section: "past",
    });
  });

  it("extracts an explicit behavioral correction as a memory update", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "user correcting agent behavior" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "frustrated", note: "mildly annoyed" },
        memory_update: { content: "Never open with filler preambles", section: "past" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "以后别给废话开场白", existingStrandNames: [] });
    expect(result.memoryUpdate).toEqual({
      content: "Never open with filler preambles",
      section: "past",
    });
  });

  it("drops a stale self_model section hint (the v5 card no longer has that section)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "user correcting agent behavior" },
        memory_worthy: true,
        emotional_signal: { intensity: "light", register: "frustrated", note: "mildly annoyed" },
        // A model emitting the retired enum value fails schema validation of
        // the section field — the report must survive regardless (zod strips
        // or the runner's report extraction rejects; either way no crash).
        memory_update: { content: "Never open with filler preambles", section: "self_model" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "以后别给废话开场白", existingStrandNames: [] });
    // The invalid enum invalidates the whole report → degraded empty analysis.
    expect(result.memoryUpdate).toBeUndefined();
    expect(result.memoryWorthy).toBe(true);
  });

  it("omits memory_update when the user did not explicitly ask", async () => {
    ai.streamText.mockResolvedValue(
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
    ai.streamText.mockResolvedValue(
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
    ai.streamText.mockResolvedValue(
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
    ai.streamText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result).toEqual({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
    });
  });

  it("returns an empty analysis when the tool call is missing", async () => {
    ai.streamText.mockResolvedValue(noToolCall());
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.messageTags).toEqual({ reuse: [], create: [] });
  });

  it("sends a static shared-base system prompt and dynamic content in the user prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({ model, userMessage: "hello world", existingStrandNames: ["rust"] });

    const arg = ai.streamText.mock.calls.at(-1)?.[0] as {
      system: string;
      prompt: string;
    };
    // Static: shared sub-agent base + role instructions live in system.
    expect(arg.system).toContain("sub-agent of the Previously memory system");
    expect(arg.system).toContain("memory analyzer");
    expect(arg.system).not.toContain("hello world");
    // Dynamic: the message and topic list live in the user prompt.
    expect(arg.prompt).toContain('Message: "hello world"');
    expect(arg.prompt).toContain("rust");
  });

  it("maps evolve_card when a slice is closing", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "wrapping up" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
        closed_marking: { focus: "logistics", summary: "scheduling", tags: ["calendar"], tone: "neutral" },
        evolve_card: { worth: false, reason: "pure logistics, nothing durable" },
      }),
    );
    const result = await analyzeTurn({
      model,
      userMessage: "ok",
      existingStrandNames: [],
      closingSlice: { turns: [{ timestamp: "t", role: "user", content: "hi" }], tags: [] },
    });
    expect(result.evolveCard).toEqual({ worth: false, reason: "pure logistics, nothing durable" });
  });

  it("omits evolve_card when no slice is closing, even if the model returns it", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: true,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
        evolve_card: { worth: true, reason: "should be ignored" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.evolveCard).toBeUndefined();
  });

  it("defaults evolve_card.worth to true on analyzer failure when a slice is closing", async () => {
    ai.streamText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({
      model,
      userMessage: "x",
      existingStrandNames: [],
      closingSlice: { turns: [{ timestamp: "t", role: "user", content: "hi" }], tags: [] },
    });
    // A missed evolution is permanent memory loss — failure defaults to running.
    expect(result.evolveCard?.worth).toBe(true);
    expect(result.memoryWorthy).toBe(true);
  });

  it("does not add evolve_card to the failure fallback when no slice is closing", async () => {
    ai.streamText.mockRejectedValue(new Error("boom"));
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.evolveCard).toBeUndefined();
  });

  // ── Task 7: fitness deltas (v1.0 design §2.5) ──────────────────────────

  it("parses fitness deltas verbatim (capped at 5)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "user correcting recall" },
        memory_worthy: true,
        emotional_signal: { intensity: "strong", register: "frustrated", note: "annoyed" },
        fitness: [
          { bucket: "recall", delta: -2, evidence: "这根本不是我们聊过的内容" },
          { bucket: "interaction", delta: 1, evidence: "exactly what I needed" },
          ...Array.from({ length: 5 }, (_, i) => ({
            bucket: "card",
            delta: 0,
            evidence: `filler ${i}`,
          })),
        ],
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.fitness).toHaveLength(5);
    expect(result.fitness![0]).toEqual({
      bucket: "recall",
      delta: -2,
      evidence: "这根本不是我们聊过的内容",
    });
  });

  it("passes an evidence-less delta through (the store boundary force-zeroes it — no duplication here)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: true,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
        fitness: [{ bucket: "card", delta: -1, evidence: "  " }],
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(result.fitness).toEqual([{ bucket: "card", delta: -1, evidence: "  " }]);
  });

  it("omits fitness when the model emits none (the no-signal state)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "greeting" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    const result = await analyzeTurn({ model, userMessage: "你好", existingStrandNames: [] });
    expect(result.fitness).toBeUndefined();
  });

  it("lists the supplied mechanical signals in the user prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: true,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({
      model,
      userMessage: "x",
      existingStrandNames: [],
      signals: [
        {
          ts: "2026-08-27T10:00:00Z",
          sliceId: "2026-08-27-1000",
          type: "recall_rework",
          detail: "main agent read slice 2026-08-20-1430 outside recall's references",
        },
      ],
    });
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string; system: string };
    expect(arg.prompt).toContain("Mechanical signals this slice");
    expect(arg.prompt).toContain("recall_rework");
    // Static prompt carries the scoring discipline, not the per-call signal.
    expect(arg.system).toContain("Task 7");
    expect(arg.system).not.toContain("recall's references");
  });

  // ── Task 7 rubric: the evolved user portrait ───────────────────────────

  it("renders the portrait rubric into the USER prompt, never the static system prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: true,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({
      model,
      userMessage: "x",
      existingStrandNames: [],
      portrait: "用户不喜欢感性的回答",
    });
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string; system: string };
    expect(arg.prompt).toContain("Scoring rubric — the evolved user portrait");
    expect(arg.prompt).toContain("用户不喜欢感性的回答");
    expect(arg.system).not.toContain("用户不喜欢感性的回答");
    // The static system prompt carries the rubric-scoring discipline itself.
    expect(arg.system).toContain("KNOWN FAILURE PATTERN");
  });

  it("omits the rubric block when no portrait is provided", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: true,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).not.toContain("Scoring rubric");
  });

  it("runs with the 50-step anti-loop fuse (the wall clock is the real budget)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        message_tags: { reuse: [], create: [] },
        semantic_hint: { strands: [], reason: "" },
        intent: { type: "chat", reason: "chat" },
        memory_worthy: false,
        emotional_signal: { intensity: "none", register: "neutral", note: "" },
      }),
    );
    await analyzeTurn({ model, userMessage: "x", existingStrandNames: [] });
    expect(ai.isStepCount).toHaveBeenCalledWith(50);
  });
});

describe("shouldRunCardEvolution", () => {
  it("follows the analyzer's worth judgment", () => {
    expect(shouldRunCardEvolution({ evolveCard: { worth: false, reason: "trivial" } })).toBe(false);
    expect(shouldRunCardEvolution({ evolveCard: { worth: true, reason: "durable fact" } })).toBe(true);
  });

  it("defaults to true when the analyzer gave no judgment (failure fallback)", () => {
    expect(shouldRunCardEvolution({})).toBe(true);
  });
});
