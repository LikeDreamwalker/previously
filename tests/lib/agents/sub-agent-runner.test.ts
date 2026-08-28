import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

const workflow = vi.hoisted(() => {
  const writer = { write: vi.fn(async () => {}), releaseLock: vi.fn() };
  return {
    writer,
    getWritable: vi.fn(() => ({ getWriter: () => writer })),
  };
});
vi.mock("workflow", () => ({ getWritable: workflow.getWritable }));

import {
  runSubAgent,
  extractToolReport,
  createProgressEmitter,
} from "@/lib/agents/sub-agent-runner";
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

const reportSchema = z.object({
  verdict: z.string(),
  count: z.number(),
});

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    model,
    system: "static system",
    prompt: "do the task",
    tools: {},
    reportToolName: "report",
    reportSchema,
    ...overrides,
  };
}

type StreamOpts = {
  onChunk?: (event: { chunk: { type: string; text: string } }) => void;
};

interface FakeStreamSpec {
  /** Chunks replayed through onChunk before the final promises resolve. */
  chunks?: Array<{ type: "text-delta" | "reasoning-delta"; text: string }>;
  text?: string;
  reasoningText?: string;
  toolCalls?: Array<{ toolName: string; input: unknown }>;
  sources?: Array<{ sourceType: string; url?: string; title?: string }>;
}

/** A StreamTextResult stand-in: replays chunks via onChunk, then resolves. */
function fakeStream(spec: FakeStreamSpec = {}) {
  ai.streamText.mockImplementation(async (opts: StreamOpts) => {
    for (const chunk of spec.chunks ?? []) opts.onChunk?.({ chunk });
    const joined = (type: string) =>
      (spec.chunks ?? [])
        .filter((c) => c.type === type)
        .map((c) => c.text)
        .join("");
    return {
      text: Promise.resolve(spec.text ?? joined("text-delta")),
      toolCalls: Promise.resolve(spec.toolCalls ?? []),
      reasoningText: Promise.resolve(
        spec.reasoningText ?? (joined("reasoning-delta") || undefined),
      ),
      sources: Promise.resolve(spec.sources ?? []),
      warnings: Promise.resolve([]),
    };
  });
}

function lastCall() {
  return ai.streamText.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSubAgent", () => {
  it("extracts and validates the report tool call", async () => {
    fakeStream({
      toolCalls: [
        { toolName: "other", input: { ignored: true } },
        { toolName: "report", input: { verdict: "ok", count: 3 } },
      ],
    });

    const res = await runSubAgent(baseOpts());
    expect(res.ok).toBe(true);
    expect(res.report).toEqual({ verdict: "ok", count: 3 });
  });

  it("returns report: undefined when the report tool was never called", async () => {
    fakeStream();
    const res = await runSubAgent(baseOpts());
    expect(res.ok).toBe(true);
    expect(res.report).toBeUndefined();
  });

  it("returns report: undefined when the report input fails schema validation", async () => {
    fakeStream({
      toolCalls: [{ toolName: "report", input: { verdict: 42 } }],
    });
    const res = await runSubAgent(baseOpts());
    expect(res.ok).toBe(true);
    expect(res.report).toBeUndefined();
  });

  it("surfaces the final text and reasoning from the stream promises", async () => {
    fakeStream({
      toolCalls: [{ toolName: "report", input: { verdict: "ok", count: 1 } }],
      text: "some text",
      reasoningText: "thought trail",
    });
    const res = await runSubAgent(baseOpts());
    expect(res.text).toBe("some text");
    expect(res.reasoning).toBe("thought trail");
  });

  it("returns a structured timeout on the SDK abort, keeping the accumulated partial", async () => {
    ai.streamText.mockImplementation(async (opts: StreamOpts) => {
      opts.onChunk?.({ chunk: { type: "reasoning-delta", text: "half a thought" } });
      opts.onChunk?.({ chunk: { type: "text-delta", text: "partial answer" } });
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    const res = await runSubAgent(baseOpts({ timeoutMs: 5_000 }));
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.error).toMatch(/5s/);
    // thinkDeep partial semantics: whatever streamed before the abort survives.
    expect(res.text).toBe("partial answer");
    expect(res.reasoning).toBe("half a thought");
  });

  it("returns a structured error result on other failures (never throws)", async () => {
    ai.streamText.mockRejectedValue(new Error("provider down"));
    const res = await runSubAgent(baseOpts());
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBeUndefined();
    expect(res.text).toBe("");
    expect(res.error).toBe("provider down");
  });

  it("passes the step cap as stopWhen: isStepCount(maxSteps)", async () => {
    fakeStream();
    await runSubAgent(baseOpts({ maxSteps: 4 }));

    const stopWhen = lastCall().stopWhen as (opts: {
      steps: unknown[];
    }) => boolean;
    expect(typeof stopWhen).toBe("function");
    expect(stopWhen({ steps: new Array(4).fill({}) })).toBe(true);
    expect(stopWhen({ steps: new Array(3).fill({}) })).toBe(false);
  });

  it("omits stopWhen when no step cap is given", async () => {
    fakeStream();
    await runSubAgent(baseOpts());
    expect(lastCall().stopWhen).toBeUndefined();
  });

  it("requests thinking ON at low effort by default (DeepSeek shape)", async () => {
    fakeStream();
    await runSubAgent(baseOpts());
    expect(lastCall().providerOptions).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "low" },
    });
  });

  it("honors an explicit effort override", async () => {
    fakeStream();
    await runSubAgent(baseOpts({ effort: "high" }));
    expect(lastCall().providerOptions).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    });
  });

  it("passes the wall-clock budget to the SDK timeout hook", async () => {
    fakeStream();
    await runSubAgent(baseOpts({ timeoutMs: 12_000 }));
    expect(lastCall().timeout).toBe(12_000);
  });

  it("never sets maxOutputTokens (project-wide ban)", async () => {
    fakeStream();
    await runSubAgent(baseOpts());
    expect("maxOutputTokens" in lastCall()).toBe(false);
  });

  it("defaults temperature to 0.1 and honors overrides", async () => {
    fakeStream();
    await runSubAgent(baseOpts());
    expect(lastCall().temperature).toBe(0.1);
    await runSubAgent(baseOpts({ temperature: 0 }));
    expect(lastCall().temperature).toBe(0);
  });

  it("emits a start line onto data-tool-progress when a toolCallId is present", async () => {
    fakeStream();
    await runSubAgent(
      baseOpts({
        progress: { toolCallId: "tc-1", toolName: "turn-analyzer" },
        startLine: "分析本轮…",
      }),
    );

    expect(workflow.writer.write).toHaveBeenCalledWith({
      type: "data-tool-progress",
      id: "tool-tc-1",
      data: {
        toolCallId: "tc-1",
        toolName: "turn-analyzer",
        text: "分析本轮…",
        stage: "running",
      },
    });
    // The writer lock is always released on settle.
    expect(workflow.writer.releaseLock).toHaveBeenCalled();
  });

  it("degrades progress to a noop without a toolCallId (getWritable never touched)", async () => {
    fakeStream();
    await runSubAgent(
      baseOpts({ progress: { toolName: "turn-analyzer" }, startLine: "x" }),
    );
    expect(workflow.getWritable).not.toHaveBeenCalled();
  });

  it("streams reasoning chunks as thinking lines, then text chunks as writing lines", async () => {
    fakeStream({
      chunks: [
        { type: "reasoning-delta", text: "first thought!!" },
        { type: "reasoning-delta", text: "\nnext" },
        { type: "text-delta", text: "the answer" },
      ],
      toolCalls: [{ toolName: "report", input: { verdict: "ok", count: 1 } }],
    });
    await runSubAgent(
      baseOpts({ progress: { toolCallId: "tc-2", toolName: "recall" } }),
    );

    const lines = (
      workflow.writer.write.mock.calls as unknown as Array<
        [{ data: { text: string; stage: string } }]
      >
    ).map((c) => c[0].data);
    // First reasoning line is "thinking"; the newline resets the current line
    // (shorter → forces a send); the stage change to "writing" forces a send
    // even within the throttle window.
    expect(lines).toContainEqual(
      expect.objectContaining({ text: "first thought!!", stage: "thinking" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ text: "next", stage: "thinking" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ text: "the answer", stage: "writing" }),
    );
    // Settle: the final line was already the last write, and the lock is
    // always released.
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({ text: "the answer", stage: "writing" }),
    );
    expect(workflow.writer.releaseLock).toHaveBeenCalled();
  });

  it("downgrades a required tool choice to auto on DeepSeek (thinking × forced choice is a provider 400)", async () => {
    fakeStream({
      toolCalls: [{ toolName: "report", input: { verdict: "ok", count: 1 } }],
    });
    const res = await runSubAgent(baseOpts({ toolChoice: "required" }));
    expect(res.ok).toBe(true);
    expect(res.report).toEqual({ verdict: "ok", count: 1 });
    expect(lastCall().toolChoice).toBe("auto");
    // Thinking stays ON for the primary attempt.
    expect(lastCall().providerOptions).toMatchObject({
      deepseek: { thinking: { type: "enabled" } },
    });
    expect(ai.streamText).toHaveBeenCalledTimes(1);
  });

  it("retries once with thinking OFF + required when the DeepSeek auto attempt yields no report", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ai.streamText
      .mockImplementationOnce(async () => ({
        text: Promise.resolve("prose answer, no tool call"),
        toolCalls: Promise.resolve([]),
        reasoningText: Promise.resolve(undefined),
        sources: Promise.resolve([]),
        warnings: Promise.resolve([]),
      }))
      .mockImplementationOnce(async () => ({
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([
          { toolName: "report", input: { verdict: "retried", count: 2 } },
        ]),
        reasoningText: Promise.resolve(undefined),
        sources: Promise.resolve([]),
        warnings: Promise.resolve([]),
      }));
    const res = await runSubAgent(baseOpts({ toolChoice: "required" }));
    expect(res.ok).toBe(true);
    expect(res.report).toEqual({ verdict: "retried", count: 2 });
    expect(ai.streamText).toHaveBeenCalledTimes(2);
    const second = ai.streamText.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(second.toolChoice).toBe("required");
    expect(second.providerOptions).toMatchObject({
      deepseek: { thinking: { type: "disabled" } },
    });
    warn.mockRestore();
  });

  it("keeps toolChoice required as-is for non-DeepSeek providers", async () => {
    fakeStream({
      toolCalls: [{ toolName: "report", input: { verdict: "ok", count: 1 } }],
    });
    await runSubAgent(
      baseOpts({
        toolChoice: "required",
        model: { ...model, sdk: "anthropic" },
      }),
    );
    expect(lastCall().toolChoice).toBe("required");
  });

  it("delivers live lines to onLine even without a toolCallId (evolution path)", async () => {
    fakeStream({
      chunks: [
        { type: "reasoning-delta", text: "reasoning " },
        { type: "reasoning-delta", text: "grows" },
        { type: "text-delta", text: "done" },
      ],
    });
    const onLine = vi.fn();
    await runSubAgent(baseOpts({ onLine }));

    // Raw per-delta callback — the caller owns throttling.
    expect(onLine.mock.calls).toEqual([
      ["reasoning ", "thinking"],
      ["reasoning grows", "thinking"],
      ["done", "writing"],
    ]);
    // No toolCallId → the tool-progress emitter stayed noop.
    expect(workflow.getWritable).not.toHaveBeenCalled();
  });

  it("still maps sub-agent tool starts to progress lines (onToolProgress)", async () => {
    fakeStream();
    const onToolProgress = vi.fn(() => ({ line: "Searching…", stage: "running" as const }));
    await runSubAgent(
      baseOpts({
        progress: { toolCallId: "tc-3", toolName: "flash-search" },
        onToolProgress,
      }),
    );

    const hook = lastCall().onToolExecutionStart as (e: {
      toolCall: { toolName: string; input: unknown };
    }) => void;
    hook({ toolCall: { toolName: "web_search", input: {} } });
    expect(onToolProgress).toHaveBeenCalledWith({
      toolName: "web_search",
      input: {},
    });
    expect(workflow.writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ text: "Searching…", stage: "running" }),
      }),
    );
  });
});

describe("extractToolReport", () => {
  it("finds the named tool call and validates its input", () => {
    const report = extractToolReport(
      [{ toolName: "report", input: { verdict: "v", count: 2 } }],
      "report",
      reportSchema,
    );
    expect(report).toEqual({ verdict: "v", count: 2 });
  });

  it("returns undefined for missing calls, null input, or schema mismatch", () => {
    expect(extractToolReport(undefined, "report", reportSchema)).toBeUndefined();
    expect(
      extractToolReport([{ toolName: "report", input: null }], "report", reportSchema),
    ).toBeUndefined();
    expect(
      extractToolReport([{ toolName: "report", input: { nope: 1 } }], "report", reportSchema),
    ).toBeUndefined();
  });
});

describe("createProgressEmitter", () => {
  it("is a noop without a toolCallId", () => {
    const e = createProgressEmitter({ toolName: "x" });
    e.emit("line", "running");
    e.close("done");
    expect(workflow.getWritable).not.toHaveBeenCalled();
  });

  it("stays noop when getWritable throws (outside a workflow step)", () => {
    workflow.getWritable.mockImplementationOnce(() => {
      throw new Error("no writable");
    });
    const e = createProgressEmitter({ toolCallId: "tc-x", toolName: "x" });
    e.emit("line", "running");
    e.close("final");
    expect(workflow.writer.write).not.toHaveBeenCalled();
  });
});
