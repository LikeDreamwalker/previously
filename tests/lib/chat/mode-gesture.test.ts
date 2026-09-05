/**
 * The card-style swipe commit decision (v0.10 §5.2/§6.1 Rev 2): a left drag
 * commits past a displacement threshold or on a fast left fling; rightward
 * never commits (chat mode has nothing to the right).
 */
import { describe, it, expect } from "vitest";
import {
  shouldCommitModeSwitch,
  MODE_SWITCH_DISTANCE_PX,
  MODE_SWITCH_VELOCITY_PX_S,
} from "@/lib/chat/mode-gesture";

describe("shouldCommitModeSwitch", () => {
  it("commits once the card traveled past the distance threshold", () => {
    expect(shouldCommitModeSwitch(-MODE_SWITCH_DISTANCE_PX, 0)).toBe(true);
    expect(shouldCommitModeSwitch(-MODE_SWITCH_DISTANCE_PX - 1, 0)).toBe(true);
  });

  it("commits on a fast left fling even under the distance threshold", () => {
    expect(shouldCommitModeSwitch(-20, -MODE_SWITCH_VELOCITY_PX_S)).toBe(true);
    expect(shouldCommitModeSwitch(0, -2000)).toBe(true);
  });

  it("springs back under both thresholds", () => {
    expect(shouldCommitModeSwitch(-MODE_SWITCH_DISTANCE_PX + 1, 0)).toBe(false);
    expect(shouldCommitModeSwitch(0, 0)).toBe(false);
    expect(
      shouldCommitModeSwitch(-50, -MODE_SWITCH_VELOCITY_PX_S + 1),
    ).toBe(false);
  });

  it("never commits rightward — no mode lives to the right of chat", () => {
    expect(shouldCommitModeSwitch(500, 0)).toBe(false);
    expect(shouldCommitModeSwitch(0, 1500)).toBe(false);
  });
});
