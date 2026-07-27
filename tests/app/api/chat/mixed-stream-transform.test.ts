import { describe, it, expect } from "vitest";
import { createMixedStreamTransform } from "@/app/api/chat/mixed-stream-transform";

// The transform guards a subtle boundary: raw model parts written by
// WorkflowAgent SHARE type strings with UIMessageChunks but use different
// fields (text vs delta, id vs toolCallId). Only chunks our own steps write
// may pass through untouched; everything else must be converted.

async function through(chunks: unknown[]): Promise<unknown[]> {
  const t = createMixedStreamTransform();
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const out: unknown[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for (const c of chunks) await writer.write(c);
  await writer.close();
  await pump;
  return out;
}

describe("createMixedStreamTransform", () => {
  it("converts raw reasoning-delta parts (text → delta)", async () => {
    const out = await through([
      { type: "reasoning-delta", id: "reasoning-0", text: "The" },
    ]);
    expect(out).toEqual([
      { type: "reasoning-delta", id: "reasoning-0", delta: "The" },
    ]);
  });

  it("converts raw text-delta parts (text → delta)", async () => {
    const out = await through([{ type: "text-delta", id: "1", text: "Hi" }]);
    expect(out).toEqual([{ type: "text-delta", id: "1", delta: "Hi" }]);
  });

  it("converts raw tool-input-start parts (id → toolCallId)", async () => {
    const out = await through([
      { type: "tool-input-start", id: "call_1", toolName: "readSlice" },
    ]);
    expect(out).toEqual([
      {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "readSlice",
      },
    ]);
  });

  it("converts raw tool-result parts to tool-output-available", async () => {
    const out = await through([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "readSlice",
        input: { path: "memory/x.md" },
        output: "contents",
      },
    ]);
    expect(out).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: "contents",
      },
    ]);
  });

  it("passes our lifecycle and data chunks through unchanged", async () => {
    const chunks = [
      { type: "start" },
      { type: "start-step" },
      { type: "data-loop", data: { loopId: "l1", done: false } },
      { type: "data-belief", data: { summaries: ["+ 注意到…"] } },
      { type: "finish-step" },
      { type: "finish" },
    ];
    expect(await through(chunks)).toEqual(chunks);
  });

  it("drops a raw model finish part (our steps own the finish chunk)", async () => {
    const out = await through([
      { type: "finish", finishReason: "stop", usage: { totalTokens: 3 } },
    ]);
    expect(out).toEqual([]);
  });

  it("drops model-call envelope parts", async () => {
    const out = await through([
      { type: "model-call-start", warnings: [] },
      {
        type: "model-call-end",
        finishReason: "stop",
        usage: { totalTokens: 3 },
      },
      { type: "model-call-response-metadata", id: "x" },
    ]);
    expect(out).toEqual([]);
  });
});
