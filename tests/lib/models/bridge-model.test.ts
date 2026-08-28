/**
 * BridgeChatLanguageModel — the custom LanguageModel behind `bridge/<agent>`.
 * Spawns fixture node scripts as the fake bridge command (same pattern as
 * tests/app/api/agent/delegate-task.test.ts) and verifies:
 *   - the stdin contract: JSON { task, context } (task = final user message,
 *     context = system prompt + prior history)
 *   - stdout becomes the generated text (doGenerate + one-shot doStream)
 *   - bridge failures propagate as thrown model errors — never fake output
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";

// The bridge model writes live data-phase chunks to the workflow run's
// writable; capture them here (same mocking pattern as sub-agent-runner
// tests).
const workflow = vi.hoisted(() => {
  const writer = {
    write: vi.fn(async (_chunk: unknown) => {}),
    releaseLock: vi.fn(),
  };
  return {
    writer,
    getWritable: vi.fn(() => ({ getWriter: () => writer })),
  };
});
vi.mock("workflow", () => ({ getWritable: workflow.getWritable }));

import {
  BridgeChatLanguageModel,
  createBridgeLanguageModel,
  promptToBridgePayload,
  buildBridgeToolInstruction,
  extractBridgeToolCall,
} from "@/lib/models/bridge-model";

const FIXTURES = fileURLToPath(
  new URL("../../app/api/agent/fixtures", import.meta.url),
);

/** Quote both segments — node may live in a path with spaces. */
function bridgeCmd(fixture: string): string {
  return `"${process.execPath}" "${join(FIXTURES, fixture)}"`;
}

const SAVED_ENV = {
  cmd: process.env.PREVIOUSLY_BRIDGE_CMD,
  timeout: process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS,
};

beforeEach(() => {
  delete process.env.PREVIOUSLY_BRIDGE_CMD;
  delete process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS;
  workflow.writer.write.mockClear();
  workflow.writer.releaseLock.mockClear();
  workflow.getWritable.mockClear();
});

afterAll(() => {
  if (SAVED_ENV.cmd === undefined) delete process.env.PREVIOUSLY_BRIDGE_CMD;
  else process.env.PREVIOUSLY_BRIDGE_CMD = SAVED_ENV.cmd;
  if (SAVED_ENV.timeout === undefined)
    delete process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS;
  else process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS = SAVED_ENV.timeout;
});

const PROMPT: LanguageModelV3Prompt = [
  { role: "system", content: "You are Previously." },
  { role: "user", content: [{ type: "text", text: "hello" }] },
  { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  { role: "user", content: [{ type: "text", text: "summarize my week" }] },
];

describe("promptToBridgePayload", () => {
  it("uses the final user message as task and the rest as context", () => {
    const { task, context } = promptToBridgePayload(PROMPT);
    expect(task).toBe("summarize my week");
    expect(context).toContain("[System]\nYou are Previously.");
    expect(context).toContain("[User]\nhello");
    expect(context).toContain("[Assistant]\nhi there");
    expect(context).not.toContain("summarize my week");
  });

  it("falls back to the whole transcript as task when the prompt ends otherwise", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "sys" },
      { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
    ];
    const { task, context } = promptToBridgePayload(prompt);
    expect(task).toContain("[System]\nsys");
    expect(task).toContain("[Assistant]\npartial answer");
    expect(context).toBeNull();
  });
});

describe("BridgeChatLanguageModel", () => {
  it("is a spec-v3 language model with honest identity fields", () => {
    const model = createBridgeLanguageModel("bridge/claude");
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("previously-bridge");
    expect(model.modelId).toBe("bridge/claude");
  });

  it("doGenerate pipes {task, context} JSON to the bridge and returns its stdout", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({ prompt: PROMPT });

    // The fixture echoes `ok:<task>|ctx:<context>` — this asserts the exact
    // stdin contract the client repo's bridge adapters implement.
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          "ok:summarize my week|ctx:[System]\nYou are Previously.\n\n" +
          "[User]\nhello\n\n[Assistant]\nhi there",
      },
    ]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined });
    // No token accounting exists for a subprocess — honestly undefined.
    expect(result.usage.inputTokens.total).toBeUndefined();
    expect(result.usage.outputTokens.total).toBeUndefined();
  });

  it("doStream replays the one-shot result as a single text delta", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({ prompt: PROMPT });

    const parts: Array<{ type: string; delta?: string }> = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as { type: string; delta?: string });
    }

    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const delta = parts.find((p) => p.type === "text-delta")?.delta ?? "";
    expect(delta).toContain("ok:summarize my week");
  });

  it("propagates a non-zero bridge exit as a thrown model error", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-fail.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    await expect(model.doGenerate({ prompt: PROMPT })).rejects.toThrow(
      /exit-code[\s\S]*bridge exploded/,
    );
    // Structured: the error carries the failure reason, and is marked
    // FatalError/fatal so the workflow step runtime doesn't retry a
    // deterministic CLI failure.
    const err = await model.doGenerate({ prompt: PROMPT }).catch((e) => e);
    expect(err.name).toBe("FatalError");
    expect(err.fatal).toBe(true);
    expect(err.reason).toBe("exit-code");
  });

  it("propagates a missing bridge binary as a thrown model error", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD =
      "previously-bridge-definitely-not-installed-xyz bridge-exec";
    const model = new BridgeChatLanguageModel("bridge/claude");
    await expect(model.doGenerate({ prompt: PROMPT })).rejects.toThrow(
      /bridge-not-found/,
    );
  });

  it("propagates a bridge timeout as a thrown model error", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-hang.mjs");
    process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS = "300";
    const model = new BridgeChatLanguageModel("bridge/claude");
    await expect(model.doGenerate({ prompt: PROMPT })).rejects.toThrow(
      /timeout[\s\S]*300ms/,
    );
  });

  it("treats exit 0 with empty stdout as a model error, not empty text", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-empty.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    await expect(model.doGenerate({ prompt: PROMPT })).rejects.toThrow(
      /empty-output/,
    );
  });

  it("works through the AI SDK streamText path (V3 adaptation)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const { streamText } = await import("ai");
    const result = streamText({
      model: createBridgeLanguageModel("bridge/claude"),
      messages: [{ role: "user", content: "ping" }],
    });
    // The fixture echoes `ok:<task>|ctx:<context>` — no history here.
    expect(await result.text).toBe("ok:ping|ctx:null");
  });

  it("pins PREVIOUSLY_BRAIN_AGENT from the model id for the spawned bridge", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-echo-agent.mjs");
    // The kernel env selects claude, but a bridge/kimi call must spawn the
    // bridge with kimi — selector switches apply without a restart.
    process.env.PREVIOUSLY_BRAIN_AGENT = "claude";
    try {
      const model = new BridgeChatLanguageModel("bridge/kimi");
      const result = await model.doGenerate({ prompt: PROMPT });
      expect(result.content).toEqual([
        { type: "text", text: "agent:kimi" },
      ]);

      // Unknown ids fall back to the env-selected agent.
      const fallback = new BridgeChatLanguageModel("bridge/not-an-agent");
      const fallbackResult = await fallback.doGenerate({ prompt: PROMPT });
      expect(fallbackResult.content).toEqual([
        { type: "text", text: "agent:claude" },
      ]);
    } finally {
      delete process.env.PREVIOUSLY_BRAIN_AGENT;
    }
  });

  it("round-trips through the workflow serialization statics", () => {
    const model = new BridgeChatLanguageModel("bridge/kimi");
    const serialize = (
      BridgeChatLanguageModel as unknown as Record<symbol, (m: unknown) => { modelId: string }>
    )[Symbol.for("workflow-serialize")];
    const deserialize = (
      BridgeChatLanguageModel as unknown as Record<symbol, (d: { modelId: string }) => unknown>
    )[Symbol.for("workflow-deserialize")];
    expect(typeof BridgeChatLanguageModel.classId).toBe("string");
    const revived = deserialize(serialize(model)) as BridgeChatLanguageModel;
    expect(revived).toBeInstanceOf(BridgeChatLanguageModel);
    expect(revived.modelId).toBe("bridge/kimi");
  });
});

// ─── S3: text tool protocol (structured reports) ───────────────────────────

const RECALL_REPORT_TOOL: LanguageModelV3FunctionTool = {
  type: "function",
  name: "recallReport",
  description: "Report your recall findings.",
  inputSchema: {
    type: "object",
    properties: {
      hits: { type: "array" },
      confidence: { type: "number" },
      reasoning: { type: "string" },
      recommended_reads: { type: "array" },
    },
    required: ["hits", "confidence", "reasoning", "recommended_reads"],
  },
};

const SEARCH_TOOL: LanguageModelV3FunctionTool = {
  type: "function",
  name: "readGlobalTimeline",
  description: "Read the global timeline index.",
  inputSchema: { type: "object", properties: {} },
};

function withTools(
  toolChoice?: LanguageModelV3CallOptions["toolChoice"],
): Partial<LanguageModelV3CallOptions> {
  return {
    tools: [SEARCH_TOOL, RECALL_REPORT_TOOL],
    ...(toolChoice ? { toolChoice } : {}),
  };
}

describe("buildBridgeToolInstruction", () => {
  it("is null without tools or with toolChoice none", () => {
    expect(buildBridgeToolInstruction({ prompt: PROMPT })).toBeNull();
    expect(
      buildBridgeToolInstruction({
        prompt: PROMPT,
        tools: [RECALL_REPORT_TOOL],
        toolChoice: { type: "none" },
      }),
    ).toBeNull();
  });

  it("lists every offered function tool with description and JSON schema", () => {
    const instruction = buildBridgeToolInstruction({
      prompt: PROMPT,
      ...withTools({ type: "auto" }),
    })!;
    expect(instruction).toContain("recallReport: Report your recall findings.");
    expect(instruction).toContain("readGlobalTimeline");
    expect(instruction).toContain(JSON.stringify(RECALL_REPORT_TOOL.inputSchema));
    expect(instruction).toContain('{"tool": "<name>", "input": {...}}');
    // auto → plain text is allowed
    expect(instruction).toContain("plain text only");
  });

  it("states the MUST requirement for required / pinned tool choice", () => {
    const required = buildBridgeToolInstruction({
      prompt: PROMPT,
      ...withTools({ type: "required" }),
    })!;
    expect(required).toContain("You MUST end your reply with a JSON tool call");
    const pinned = buildBridgeToolInstruction({
      prompt: PROMPT,
      ...withTools({ type: "tool", toolName: "recallReport" }),
    })!;
    expect(pinned).toContain('for "recallReport"');
  });
});

describe("extractBridgeToolCall", () => {
  const NAMES = new Set(["recallReport", "readGlobalTimeline"]);

  it("extracts the JSON tail and keeps the preceding prose as text", () => {
    const raw =
      'Findings below.\n{"tool":"recallReport","input":{"hits":[],"confidence":0.5}}';
    const extracted = extractBridgeToolCall(raw, NAMES);
    expect(extracted).toEqual({
      text: "Findings below.",
      toolCall: {
        toolName: "recallReport",
        input: { hits: [], confidence: 0.5 },
      },
    });
  });

  it("handles nested braces inside the input object", () => {
    const raw =
      '{"tool":"recallReport","input":{"hits":[{"slice_id":"2026-08-22-0340","reason":"a } b"}]}}';
    const extracted = extractBridgeToolCall(raw, NAMES);
    expect(extracted?.text).toBe("");
    expect(extracted?.toolCall.toolName).toBe("recallReport");
  });

  it("returns null without a JSON tail or for unoffered tool names", () => {
    expect(extractBridgeToolCall("plain answer", NAMES)).toBeNull();
    expect(
      extractBridgeToolCall('{"tool":"otherTool","input":{}}', NAMES),
    ).toBeNull();
    expect(
      extractBridgeToolCall("prose then {not json}", NAMES),
    ).toBeNull();
  });

  it("honors the forced tool name", () => {
    const raw = '{"tool":"readGlobalTimeline","input":{}}';
    expect(extractBridgeToolCall(raw, NAMES, "recallReport")).toBeNull();
    expect(extractBridgeToolCall(raw, NAMES, "readGlobalTimeline")?.toolCall.toolName)
      .toBe("readGlobalTimeline");
  });

  it("defaults a missing input to an empty object", () => {
    const extracted = extractBridgeToolCall('{"tool":"recallReport"}', NAMES);
    expect(extracted?.toolCall.input).toEqual({});
  });
});

describe("BridgeChatLanguageModel tool protocol", () => {
  it("appends the tool instruction and protocol version to the stdin payload", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-echo-payload.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({
      prompt: PROMPT,
      ...withTools({ type: "auto" }),
    });
    const text = result.content.find((p) => p.type === "text");
    const payload = JSON.parse((text as { text: string }).text);
    expect(payload.protocol).toBe(2);
    expect(payload.task).toContain("summarize my week");
    expect(payload.task).toContain("[Tool protocol");
    expect(payload.task).toContain("recallReport");
    // Tool-protocol calls carry NO phase — the chat skill doc's output
    // contract contradicts the required {"tool": …} JSON tail.
    expect(payload.phase).toBeUndefined();
    // Function tools are now supported — no "unsupported tools" warning.
    expect(result.warnings).toEqual([]);
  });

  it("stamps phase 'chat' on plain chat calls (no tool protocol)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-echo-payload.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({ prompt: PROMPT });
    const text = result.content.find((p) => p.type === "text");
    const payload = JSON.parse((text as { text: string }).text);
    expect(payload.phase).toBe("chat");
    expect(payload.protocol).toBe(2);
  });

  it("parses the JSON tail into a tool-call content part (required)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-report.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({
      prompt: PROMPT,
      ...withTools({ type: "required" }),
    });

    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: undefined });
    const text = result.content.find((p) => p.type === "text");
    expect((text as { text: string }).text).toBe(
      "Here are my findings from the timeline.",
    );
    const call = result.content.find((p) => p.type === "tool-call") as {
      toolCallId: string;
      toolName: string;
      input: string;
    };
    expect(call.toolName).toBe("recallReport");
    expect(call.toolCallId).toMatch(/^bridge-call-/);
    expect(JSON.parse(call.input)).toEqual({
      hits: [],
      confidence: 0.5,
      reasoning: "nothing matched",
      recommended_reads: [],
    });
  });

  it("doStream replays a report as tool-input parts + tool-call", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-report.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({
      prompt: PROMPT,
      ...withTools({ type: "tool", toolName: "recallReport" }),
    });

    const parts: Array<Record<string, unknown>> = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as Record<string, unknown>);
    }

    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    const call = parts.find((p) => p.type === "tool-call")!;
    expect(call.toolName).toBe("recallReport");
    const inputDelta = parts.find((p) => p.type === "tool-input-delta")!;
    expect(inputDelta.id).toBe(call.toolCallId);
    expect(JSON.parse(inputDelta.delta as string)).toMatchObject({
      confidence: 0.5,
    });
    const finish = parts.find((p) => p.type === "finish")!;
    expect(finish.finishReason).toEqual({ unified: "tool-calls", raw: undefined });
  });

  it("keeps plain-text answers as text under toolChoice auto (no fake calls)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({
      prompt: PROMPT,
      ...withTools({ type: "auto" }),
    });
    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined });
    expect(result.content.every((p) => p.type === "text")).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ok:summarize my week");
  });

  it("keeps a JSON tail naming an unoffered tool as text under auto", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-report-wrong-tool.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({
      prompt: PROMPT,
      ...withTools({ type: "auto" }),
    });
    expect(result.finishReason.unified).toBe("stop");
    expect(result.content.every((p) => p.type === "text")).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "notAnOfferedTool",
    );
  });

  it("throws invalid-report when a required report tail is missing", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const err = await model
      .doGenerate({ prompt: PROMPT, ...withTools({ type: "required" }) })
      .catch((e) => e);
    expect(err.name).toBe("FatalError");
    expect(err.fatal).toBe(true);
    expect(err.reason).toBe("invalid-report");
    expect(err.message).toContain("invalid-report");
  });

  it("throws invalid-report when the pinned tool's tail names a different tool", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-report-wrong-tool.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    await expect(
      model.doGenerate({
        prompt: PROMPT,
        ...withTools({ type: "tool", toolName: "recallReport" }),
      }),
    ).rejects.toThrow(/invalid-report[\s\S]*recallReport/);
  });

  it("warns about provider-executed tools (they cannot ride the bridge)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({
      prompt: PROMPT,
      tools: [
        RECALL_REPORT_TOOL,
        { type: "provider", id: "openai.web_search", name: "web_search", args: {} } as never,
      ],
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: "unsupported", feature: "tools" }),
    ]);
  });
});

// ─── S4: live protocol-2 events → data-phase ───────────────────────────────

describe("BridgeChatLanguageModel live events", () => {
  it("forwards protocol-2 events as data-phase chunks and settles the phase", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-proto2.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({ prompt: PROMPT });
    const text = result.content.find((p) => p.type === "text");
    expect((text as { text: string }).text).toBe("the final answer");

    const writes = workflow.writer.write.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.type).toBe("data-phase");
      expect(w.id).toBe("phase-bridge");
      expect(w.data).toMatchObject({ phase: "stageWorking" });
    }
    // The final frame settles the indicator (running: false) with the full
    // summaries list (consecutive start→ok duplicates collapsed).
    const last = writes[writes.length - 1].data as {
      running: boolean;
      summaries: string[];
    };
    expect(last.running).toBe(false);
    expect(last.summaries).toEqual(["Read memory/2026-08-22-0340.md"]);
    expect(workflow.writer.releaseLock).toHaveBeenCalled();
  });

  it("writes only the kickoff + settle frames for legacy plain-text CLIs", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    await model.doGenerate({ prompt: PROMPT });
    // The chat path kicks off a "Working…" frame up front so a silent CLI
    // never leaves a blank wait; the settle frame closes it. No activity
    // ever arrives, so both frames carry empty summaries/tools.
    const writes = workflow.writer.write.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(writes).toHaveLength(2);
    expect(writes[0].data).toMatchObject({
      phase: "stageWorking",
      running: true,
      summaries: [],
      tools: [],
    });
    expect(writes[1].data).toMatchObject({ running: false });
  });
});

describe("BridgeChatLanguageModel sub-agent loop (recall pattern)", () => {
  it("executes server-side kernel tools and feeds results back as transcript text", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-recall-loop.mjs");
    const { streamText, tool, isStepCount } = await import("ai");
    const { z } = await import("zod");

    let executed = 0;
    const result = streamText({
      model: new BridgeChatLanguageModel("bridge/claude"),
      prompt: "find past chats about gardening",
      tools: {
        readGlobalTimeline: tool({
          description: "Read the global timeline index.",
          inputSchema: z.object({}),
          execute: async () => {
            executed++;
            return "TIMELINE: 2026-08-22-0340 gardening chat";
          },
        }),
        recallReport: tool({
          description: "Report your recall findings.",
          inputSchema: z.object({
            hits: z.array(z.unknown()),
            confidence: z.number(),
            reasoning: z.string(),
            recommended_reads: z.array(z.unknown()),
          }),
        }),
      },
      toolChoice: "auto",
      stopWhen: isStepCount(8),
    });

    const toolCalls = await result.toolCalls;
    // Round 1: the CLI "called" readGlobalTimeline → executed server-side.
    expect(executed).toBe(1);
    // Round 2: its result rode the transcript back; the CLI then reported.
    const report = toolCalls.find((tc) => tc.toolName === "recallReport");
    expect(report).toBeDefined();
    expect(report!.input).toMatchObject({
      confidence: 0.4,
      reasoning: "searched the timeline",
    });
  });
});

// ─── S5: live text deltas (protocol 2) ─────────────────────────────────────

/** Drain a model stream into a plain part list. */
async function drainStream(
  stream: ReadableStream<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Record<string, unknown>);
  }
  return parts;
}

describe("BridgeChatLanguageModel streaming deltas", () => {
  it("streams live {" + '"delta"' + "} lines as incremental text-delta parts", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-proto2-delta.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts = await drainStream(stream);

    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const deltas = parts.filter((p) => p.type === "text-delta");
    // Deltas concat exactly to the envelope result — nothing to reconcile.
    expect(deltas.map((d) => d.delta)).toEqual(["Hello, ", "world!"]);
    expect(deltas.every((d) => d.id === "bridge-text-1")).toBe(true);
  });

  it("reconciles a dropped delta tail: the envelope result wins (remainder appended)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd(
      "bridge-proto2-delta-truncated.mjs",
    );
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts = await drainStream(stream);

    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text).toBe("Hello, world!");
    // One text block: start → "Hello, " → remainder "world!" → end.
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("re-emits the authoritative result as a fresh block when deltas diverge", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd(
      "bridge-proto2-delta-mismatch.mjs",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const model = new BridgeChatLanguageModel("bridge/claude");
      const { stream } = await model.doStream({ prompt: PROMPT });
      const parts = await drainStream(stream);

      expect(parts.map((p) => p.type)).toEqual([
        "stream-start",
        "text-start",
        "text-delta", // advisory "draft"
        "text-end",
        "text-start", // reconciled block
        "text-delta", // "final answer"
        "text-end",
        "finish",
      ]);
      const deltas = parts.filter((p) => p.type === "text-delta");
      expect(deltas[0].delta).toBe("draft");
      expect(deltas[1].delta).toBe("final answer");
      expect(deltas[1].id).toBe("bridge-text-2");
      // The reconciled block is marked authoritative so the client REPLACES
      // the advisory text instead of concatenating the two.
      const starts = parts.filter((p) => p.type === "text-start");
      expect(starts[0].providerMetadata).toBeUndefined();
      expect(starts[1].providerMetadata).toEqual({
        "previously-bridge": { authoritative: true },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("diverge from the envelope"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the one-shot replay when a protocol-2 CLI emits no deltas", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-proto2.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts = await drainStream(stream);

    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const deltas = parts.filter((p) => p.type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe("the final answer");
  });

  it("never streams deltas live on tool-protocol calls (the JSON tail must not render)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd(
      "bridge-proto2-delta-report.mjs",
    );
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({
      prompt: PROMPT,
      ...withTools({ type: "tool", toolName: "recallReport" }),
    });
    const parts = await drainStream(stream);

    // One-shot replay: exactly one text delta, and it carries only the prose.
    const deltas = parts.filter((p) => p.type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe("Here are my findings from the timeline.");
    const call = parts.find((p) => p.type === "tool-call")!;
    expect(call.toolName).toBe("recallReport");
    const finish = parts.find((p) => p.type === "finish")!;
    expect(finish.finishReason).toEqual({
      unified: "tool-calls",
      raw: undefined,
    });
  });

  it("errors the stream (never fakes output) when the bridge fails", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-fail.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const { stream } = await model.doStream({ prompt: PROMPT });
    await expect(drainStream(stream)).rejects.toThrow(/exit-code/);
  });
});

describe("createBridgeEventEmitter tools accumulation", () => {
  it("collapses start → ok pairs into one row and settles running=false", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    const frames: Array<{
      phase: string;
      running: boolean;
      summaries: string[];
      tools: Array<{ name: string; summary: string; status: string }>;
    }> = [];
    const emitter = createBridgeEventEmitter({
      id: "phase-bridge-housekeeping",
      phase: "bridgeHousekeeping",
      write: (data) => frames.push(data),
    });

    emitter.onEvent({ name: "Read", summary: "Read a.md", status: "start" });
    emitter.onEvent({ name: "Read", summary: "Read a.md", status: "ok" });
    emitter.onEvent({ name: "Bash", summary: "Bash pnpm test", status: "error" });
    emitter.finish();

    // The custom write path never touches the workflow writable.
    expect(workflow.getWritable).not.toHaveBeenCalled();
    expect(frames.length).toBeGreaterThan(0);
    const last = frames[frames.length - 1];
    expect(last.phase).toBe("bridgeHousekeeping");
    expect(last.running).toBe(false);
    expect(last.tools).toEqual([
      { name: "Read", summary: "Read a.md", status: "ok" },
      { name: "Bash", summary: "Bash pnpm test", status: "error" },
    ]);
    expect(last.summaries).toEqual(["Read a.md", "Bash pnpm test"]);
  });

  it("is silent when no events arrive (no phantom phase)", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    const frames: unknown[] = [];
    const emitter = createBridgeEventEmitter({ write: (d) => frames.push(d) });
    emitter.finish();
    expect(frames).toEqual([]);
  });

  it("onDelta folds narration into one rolling current line", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    const frames: Array<{ running: boolean; live?: string; tools: unknown[] }> =
      [];
    const emitter = createBridgeEventEmitter({ write: (d) => frames.push(d) });

    // First delta writes immediately (throttle clock starts at 0).
    emitter.onDelta("Reading the slice");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      running: true,
      live: "Reading the slice",
      tools: [],
    });

    // A same-tick delta is throttled (no new frame) but still folds in.
    emitter.onDelta("…");
    expect(frames).toHaveLength(1);
    emitter.finish();
    const last = frames[frames.length - 1];
    expect(last.running).toBe(false);
    expect(last.live).toBe("Reading the slice…");
  });

  it("onDelta rolls to a new line on newline boundaries", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    const frames: Array<{ live?: string }> = [];
    const emitter = createBridgeEventEmitter({ write: (d) => frames.push(d) });

    emitter.onDelta("first line\nsecond ");
    emitter.finish();
    // Only the fragment after the last newline survives.
    expect(frames[frames.length - 1].live).toBe("second ");
  });

  it("onDelta caps the rolling line (tail kept) and narration alone settles the phase", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    const frames: Array<{ running: boolean; live?: string }> = [];
    const emitter = createBridgeEventEmitter({ write: (d) => frames.push(d) });

    emitter.onDelta("x".repeat(400));
    emitter.finish();
    const last = frames[frames.length - 1];
    expect(last.live).toHaveLength(300);
    // Narration-only run (zero tool calls): frames were still written and the
    // indicator settles.
    expect(frames.length).toBeGreaterThan(0);
    expect(last.running).toBe(false);
  });

  it("kickoff writes an immediate running frame and finish settles it", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    const frames: Array<{ running: boolean; tools: unknown[] }> = [];
    const emitter = createBridgeEventEmitter({ write: (d) => frames.push(d) });

    emitter.kickoff();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ running: true, tools: [] });

    emitter.finish();
    expect(frames[frames.length - 1].running).toBe(false);
  });

  it("retries writer acquisition after a transient lock contention", async () => {
    const { createBridgeEventEmitter } = await import(
      "@/lib/models/bridge-model"
    );
    // First acquisition fails (the WorkflowAgent's writer holds the lock) —
    // the frame is dropped, but the emitter must NOT go permanently noop.
    workflow.getWritable.mockReturnValueOnce({
      getWriter: () => {
        throw new TypeError("Writer is locked");
      },
    } as unknown as ReturnType<typeof workflow.getWritable>);

    const emitter = createBridgeEventEmitter();
    emitter.onEvent({ name: "Read", summary: "Read a.md", status: "ok" });
    expect(workflow.writer.write).not.toHaveBeenCalled();

    // finish() re-acquires and lands the settle frame with the full state.
    emitter.finish();
    expect(workflow.writer.write).toHaveBeenCalledTimes(1);
    const frame = workflow.writer.write.mock.calls[0][0] as {
      data: { running: boolean; summaries: string[] };
    };
    expect(frame.data.running).toBe(false);
    expect(frame.data.summaries).toEqual(["Read a.md"]);
  });
});

// ─── S6: skills in the chat payload ────────────────────────────────────────

describe("promptToBridgePayload skills", () => {
  it("chat-phase payloads carry skills.recall with the {{PREVIOUSLY_CMD}} placeholder verbatim", () => {
    const payload = promptToBridgePayload(PROMPT);
    expect(payload.phase).toBe("chat");
    expect(typeof payload.skills.recall).toBe("string");
    // The placeholder is INTENTIONAL — the client fills it with the absolute
    // CLI prefix when materializing skills/recall.md. It must cross the wire
    // unfilled.
    expect(payload.skills.recall).toContain("{{PREVIOUSLY_CMD}}");
  });

  it("also carries skills on the whole-transcript fallback path", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "assistant", content: [{ type: "text", text: "partial" }] },
    ];
    const payload = promptToBridgePayload(prompt);
    expect(payload.skills.recall).toContain("{{PREVIOUSLY_CMD}}");
  });
});

describe("BridgeChatLanguageModel skills on the wire", () => {
  it("sends skills.recall on plain chat calls (phase chat)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-echo-payload.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({ prompt: PROMPT });
    const text = result.content.find((p) => p.type === "text");
    const payload = JSON.parse((text as { text: string }).text);
    expect(payload.phase).toBe("chat");
    expect(payload.skills.recall).toContain("{{PREVIOUSLY_CMD}}");
  });

  it("omits skills on tool-protocol calls (no phase → no skills)", async () => {
    process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-echo-payload.mjs");
    const model = new BridgeChatLanguageModel("bridge/claude");
    const result = await model.doGenerate({
      prompt: PROMPT,
      ...withTools({ type: "auto" }),
    });
    const text = result.content.find((p) => p.type === "text");
    const payload = JSON.parse((text as { text: string }).text);
    expect(payload.phase).toBeUndefined();
    expect(payload.skills).toBeUndefined();
  });
});
