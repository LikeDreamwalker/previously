import { describe, it, expect } from "vitest";
import {
  focusReducer,
  currentTurnIndex,
  INITIAL_FOCUS_STATE,
  type FocusState,
} from "@/lib/timeline3d/focus";

describe("focusReducer", () => {
  it("starts in fly mode", () => {
    expect(INITIAL_FOCUS_STATE).toEqual({ mode: "fly" });
  });

  it("FOCUS enters focus mode at turn 0", () => {
    const s = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "2026-08-01-1000",
    });
    expect(s).toEqual({ mode: "focus", sliceId: "2026-08-01-1000", turnPos: 0 });
  });

  it("only one bead is bloomed at a time: FOCUS replaces the open focus", () => {
    const a = focusReducer(INITIAL_FOCUS_STATE, { type: "FOCUS", sliceId: "a" });
    const b = focusReducer(a, { type: "FOCUS", sliceId: "b" });
    expect(b).toEqual({ mode: "focus", sliceId: "b", turnPos: 0 });
  });

  it("EXIT returns to fly from any state", () => {
    const focused = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "a",
    });
    expect(focusReducer(focused, { type: "EXIT" })).toEqual({ mode: "fly" });
    expect(focusReducer(INITIAL_FOCUS_STATE, { type: "EXIT" })).toEqual({
      mode: "fly",
    });
  });

  it("SCROLL steps turnPos and clamps to [0, turnCount-1]", () => {
    let s: FocusState = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "a",
    });
    s = focusReducer(s, { type: "SCROLL", delta: 1.5, turnCount: 4 });
    expect(s).toMatchObject({ turnPos: 1.5 });
    s = focusReducer(s, { type: "SCROLL", delta: 99, turnCount: 4 });
    expect(s).toMatchObject({ turnPos: 3 });
    s = focusReducer(s, { type: "SCROLL", delta: -99, turnCount: 4 });
    expect(s).toMatchObject({ turnPos: 0 });
  });

  it("SCROLL in fly mode is a no-op (the wheel flies instead)", () => {
    const s = focusReducer(INITIAL_FOCUS_STATE, {
      type: "SCROLL",
      delta: 3,
      turnCount: 10,
    });
    expect(s).toEqual({ mode: "fly" });
  });

  it("GOTO_TURN jumps and clamps", () => {
    let s: FocusState = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "a",
    });
    s = focusReducer(s, { type: "GOTO_TURN", index: 2, turnCount: 5 });
    expect(s).toMatchObject({ turnPos: 2 });
    s = focusReducer(s, { type: "GOTO_TURN", index: 42, turnCount: 5 });
    expect(s).toMatchObject({ turnPos: 4 });
  });

  it("a single-turn slice pins turnPos to 0", () => {
    let s: FocusState = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "a",
    });
    s = focusReducer(s, { type: "SCROLL", delta: 5, turnCount: 1 });
    expect(s).toMatchObject({ turnPos: 0 });
  });
});

describe("currentTurnIndex", () => {
  it("rounds the float position and returns null outside focus", () => {
    expect(currentTurnIndex(INITIAL_FOCUS_STATE, 10)).toBeNull();
    let s: FocusState = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "a",
    });
    s = focusReducer(s, { type: "SCROLL", delta: 2.4, turnCount: 6 });
    expect(currentTurnIndex(s, 6)).toBe(2);
    s = focusReducer(s, { type: "SCROLL", delta: 0.2, turnCount: 6 });
    expect(currentTurnIndex(s, 6)).toBe(3);
  });

  it("returns null for an empty slice", () => {
    const s = focusReducer(INITIAL_FOCUS_STATE, {
      type: "FOCUS",
      sliceId: "a",
    });
    expect(currentTurnIndex(s, 0)).toBeNull();
  });
});
