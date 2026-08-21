/**
 * BridgeChatLanguageModel — the custom LanguageModel behind `bridge/<agent>`.
 * Spawns fixture node scripts as the fake bridge command (same pattern as
 * tests/app/api/agent/delegate-task.test.ts) and verifies:
 *   - the stdin contract: JSON { task, context } (task = final user message,
 *     context = system prompt + prior history)
 *   - stdout becomes the generated text (doGenerate + one-shot doStream)
 *   - bridge failures propagate as thrown model errors — never fake output
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

import {
  BridgeChatLanguageModel,
  createBridgeLanguageModel,
  promptToBridgePayload,
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
