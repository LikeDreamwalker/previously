import { describe, it, expect } from "vitest";
import {
  shouldEmitProgress,
  PROGRESS_THROTTLE_MS,
  type ProgressWriteState,
  type ToolProgressStage,
} from "@/lib/chat/progress-throttle";

// The throttle is the server-side fix for a delivery bottleneck: the
// getWritable() pump drains ~55-60 chunks/sec, so writing every token backs up
// a queue that lands after the turn rendered. These tests pin the exact
// decision rules: first line always goes out, stage changes and line resets
// are never throttled, and steady growth is capped at PROGRESS_THROTTLE_MS.
// The stage ladder is running → thinking → writing → done; every rung change
// forces a send so the client's visual transition is never delayed.

const T = PROGRESS_THROTTLE_MS;

function emitted(
  state: ProgressWriteState,
  line: string,
  stage: ToolProgressStage = "thinking",
  now: number = T,
): boolean {
  return shouldEmitProgress(state, { line, stage }, now);
}

function stateOf(partial: Partial<ProgressWriteState>): ProgressWriteState {
  return {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
    ...partial,
  };
}

describe("shouldEmitProgress", () => {
  it("always emits the first line (no state yet)", () => {
    expect(emitted(stateOf({}), "The")).toBe(true);
  });

  it("throttles steady growth inside the window", () => {
    const state = stateOf({
      sentAny: true,
      lastWriteMs: 0,
      lastLine: "The",
      lastStage: "thinking",
    });
    // now = T - 1ms → inside the window, same stage, line grew → dropped.
    expect(shouldEmitProgress(state, { line: "The us", stage: "thinking" }, T - 1)).toBe(false);
  });

  it("emits again once the window has elapsed", () => {
    const state = stateOf({
      sentAny: true,
      lastWriteMs: 0,
      lastLine: "The",
      lastStage: "thinking",
    });
    expect(shouldEmitProgress(state, { line: "The us", stage: "thinking" }, T)).toBe(true);
  });

  it("emits immediately on a stage change (thinking → writing)", () => {
    const state = stateOf({
      sentAny: true,
      lastWriteMs: 0,
      lastLine: "The",
      lastStage: "thinking",
    });
    // Still inside the window, but the color transition must not be delayed.
    expect(shouldEmitProgress(state, { line: "The", stage: "writing" }, 1)).toBe(true);
  });

  it("emits immediately on a line reset (shorter line = newline)", () => {
    const state = stateOf({
      sentAny: true,
      lastWriteMs: 0,
      lastLine: "A long line before the newline",
      lastStage: "thinking",
    });
    // Inside the window, but the new line is shorter — the box must re-render.
    expect(shouldEmitProgress(state, { line: "Next", stage: "thinking" }, 1)).toBe(true);
  });

  it("does not treat equal-length growth as a reset", () => {
    const state = stateOf({
      sentAny: true,
      lastWriteMs: 0,
      lastLine: "abcd",
      lastStage: "writing",
    });
    // Same length, same stage, inside window → throttled.
    expect(shouldEmitProgress(state, { line: "wxyz", stage: "writing" }, 1)).toBe(false);
  });

  it("emits immediately on every stage-ladder rung (running → thinking → writing → done)", () => {
    const steps: Array<[ToolProgressStage, ToolProgressStage]> = [
      ["running", "thinking"],
      ["thinking", "writing"],
      ["writing", "done"],
    ];
    for (const [from, to] of steps) {
      const state = stateOf({
        sentAny: true,
        lastWriteMs: 0,
        lastLine: "line",
        lastStage: from,
      });
      expect(shouldEmitProgress(state, { line: "line", stage: to }, 1)).toBe(true);
    }
  });

  it("honors a custom throttle window", () => {
    const state = stateOf({
      sentAny: true,
      lastWriteMs: 0,
      lastLine: "a",
      lastStage: "thinking",
    });
    expect(shouldEmitProgress(state, { line: "ab", stage: "thinking" }, 99, 100)).toBe(false);
    expect(shouldEmitProgress(state, { line: "ab", stage: "thinking" }, 100, 100)).toBe(true);
  });
});
