import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

import { consolidateStrands } from "@/lib/episodic/flash/strand-consolidator";
import type { ModelConfig } from "@/lib/models/registry";

/** A StreamTextResult stand-in resolving to the given tool calls. */
function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build an index large enough to trigger the LLM pass (>= MIN_STRANDS_FOR_LLM). */
function bigIndex(): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (let i = 0; i < 30; i++) {
    idx[`topic-${i}`] = [`2026/08/0${(i % 7) + 1}/000${i % 10}`];
  }
  return idx;
}

describe("consolidateStrands", () => {
  it("always runs deterministic pruning, even when the LLM pass is skipped", async () => {
    // Tiny index → llmPassSkipped, but stale single-use strands still pruned.
    const now = Date.UTC(2026, 7, 7, 12, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const strands = {
      stale: ["2026/07/01/0800"], // old + single-use → pruned
      fresh: ["2026/08/06/0800"], // recent + single-use → kept
    };
    const result = await consolidateStrands(strands, model);
    expect(result.llmPassSkipped).toBe(true);
    expect(result.pruned).toEqual(["stale"]);
    expect(result.strands).toEqual({ fresh: ["2026/08/06/0800"] });
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("applies worker-proposed merges and removes the from key", async () => {
    const strands = bigIndex();
    strands["陈勇超"] = ["2026/08/02/0952"];
    strands["陈永超"] = ["2026/08/02/1050"];

    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "consolidateOutput",
          input: {
            merges: [{ from: "陈勇超", to: "陈永超", reason: "typo" }],
            reasoning: "same person, typo",
          },
        },
      ]),
    );

    const result = await consolidateStrands(strands, model);
    expect(result.llmPassSkipped).toBe(false);
    expect(result.merges).toEqual([{ from: "陈勇超", to: "陈永超", reason: "typo" }]);
    expect(result.strands["陈永超"]).toContain("2026/08/02/0952");
    expect(result.strands["陈勇超"]).toBeUndefined();
  });

  it("drops a proposal whose `to` key does not exist in the index", async () => {
    const strands = bigIndex();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "consolidateOutput",
          input: {
            merges: [{ from: "topic-0", to: "不存在", reason: "bad target" }],
            reasoning: "",
          },
        },
      ]),
    );

    const result = await consolidateStrands(strands, model);
    // No merges applied, no crash.
    expect(result.merges).toEqual([]);
    expect(result.strands["topic-0"]).toBeDefined();
  });

  it("returns the index unchanged when the worker fails", async () => {
    const strands = bigIndex();
    ai.streamText.mockRejectedValue(new Error("worker down"));

    const result = await consolidateStrands(strands, model);
    expect(result.merges).toEqual([]);
    expect(result.strands).toBeDefined();
    expect(Object.keys(result.strands).length).toBeGreaterThan(0);
  });

  it("returns an empty merge list when the worker reports no duplicates", async () => {
    const strands = bigIndex();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "consolidateOutput",
          input: { merges: [], reasoning: "index already clean" },
        },
      ]),
    );

    const result = await consolidateStrands(strands, model);
    expect(result.merges).toEqual([]);
  });
});
