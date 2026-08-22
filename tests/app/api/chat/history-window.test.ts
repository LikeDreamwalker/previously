import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { sliceAlignedWindow } from "@/app/api/chat/turn-workflow";

const u = (s: string): ModelMessage => ({ role: "user", content: s });
const a = (s: string): ModelMessage => ({ role: "assistant", content: s });
const tool = (s: string): ModelMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: s, toolName: "recall", output: { type: "text", value: s } }],
  }) as ModelMessage;

describe("sliceAlignedWindow (v0.9 — history window aligned to the time slice)", () => {
  it("new slice (1 user turn): only the current user message", () => {
    const history = [u("old"), a("old reply"), u("current")];
    expect(sliceAlignedWindow(history, 1, 100)).toEqual([u("current")]);
  });

  it("continuing slice: the tail covering exactly the slice's user turns", () => {
    const history = [
      u("previous slice"),
      a("previous reply"),
      u("s1"),
      a("r1"),
      u("s2"),
      a("r2"),
      u("s3"),
    ];
    // 3 user turns in the slice → everything since u("s1"); the previous
    // slice's messages are cut away.
    expect(sliceAlignedWindow(history, 3, 100)).toEqual(history.slice(2));
  });

  it("carries tool-call/result messages between the user turns", () => {
    const t = tool("tc1");
    const history = [u("old"), a("old reply"), u("s1"), t, a("r1"), u("s2")];
    expect(sliceAlignedWindow(history, 2, 100)).toEqual([u("s1"), t, a("r1"), u("s2")]);
  });

  it("client tail too short for the slice → degrades to all given messages", () => {
    // housekeeping's checkContextLost normally forces a new slice in this
    // situation; if it ever slips through, the window must not drop the
    // current user message or invent messages.
    const history = [u("only this")];
    expect(sliceAlignedWindow(history, 3, 100)).toEqual(history);
  });

  it("safety cap: keeps the tail and re-opens on a user boundary", () => {
    const history = [u("u1"), a("a1"), u("u2"), a("a2"), u("u3"), a("a3")];
    // Cap 5 cuts [a1, u2, a2, u3, a3] — the leading orphan assistant message
    // is dropped so the window opens on a user turn.
    expect(sliceAlignedWindow(history, 3, 5)).toEqual([u("u2"), a("a2"), u("u3"), a("a3")]);
  });

  it("treats userTurnsInSlice <= 0 as 1 (defensive)", () => {
    const history = [u("old"), a("reply"), u("current")];
    expect(sliceAlignedWindow(history, 0, 100)).toEqual([u("current")]);
  });
});
