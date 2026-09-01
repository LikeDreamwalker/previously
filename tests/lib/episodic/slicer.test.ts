import { describe, it, expect } from "vitest";
import {
  checkIdleGap,
  DEFAULT_IDLE_GAP_MS,
  DEFAULT_MAX_SLICE_AGE_MS,
} from "@/lib/episodic/slicer";

describe("checkIdleGap", () => {
  it("fires when the last turn is older than the gap", () => {
    const old = new Date(Date.now() - DEFAULT_IDLE_GAP_MS - 60_000).toISOString();
    expect(checkIdleGap(old)).toBe(true);
  });

  it("does not fire within the gap", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(checkIdleGap(recent)).toBe(false);
  });

  it("honors an explicit threshold", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(checkIdleGap(tenMinAgo, 5 * 60_000)).toBe(true);
    expect(checkIdleGap(tenMinAgo, 30 * 60_000)).toBe(false);
  });

  it("never fires on an unparseable timestamp or threshold", () => {
    expect(checkIdleGap("not-a-date")).toBe(false);
    const old = new Date(Date.now() - DEFAULT_MAX_SLICE_AGE_MS * 10).toISOString();
    expect(checkIdleGap(old, Number.NaN)).toBe(false);
  });
});
