import { describe, it, expect } from "vitest";
import { mergeConfig, mergeConfigOverrides, DEFAULTS } from "@/lib/config/defaults";
import type { UserConfig } from "@/lib/config/types";

const current: UserConfig = {
  slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: 15 },
  model: {
    provider: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "low",
  },
  onboarded: false,
  datasource: "demo",
};

describe("mergeConfigOverrides", () => {
  it("persists top-level fields without clobbering nested config", () => {
    const result = mergeConfigOverrides(current, {
      onboarded: true,
      datasource: "own",
    });
    expect(result.onboarded).toBe(true);
    expect(result.datasource).toBe("own");
    // The existing model/slicing must survive untouched.
    expect(result.model.provider).toBe("deepseek-v4-flash");
    expect(result.model.reasoningEffort).toBe("low");
    expect(result.slicing.maxSliceMinutes).toBe(30);
    expect(result.slicing.maxTurnsPerSlice).toBe(50);
  });

  it("deep-merges nested overrides while keeping untouched siblings", () => {
    const result = mergeConfigOverrides(current, {
      model: { provider: "deepseek-v4-pro" },
    });
    expect(result.model.provider).toBe("deepseek-v4-pro");
    expect(result.model.thinking).toBe(true); // sibling survives
    expect(result.onboarded).toBe(false); // untouched top-level stays
  });
});

describe("mergeConfig — slicing knob clamping (v0.9.1 server-side guard)", () => {
  // The Settings inputs' min/max are HTML hints only; mergeConfig is the
  // trusted funnel for every read AND every save.

  it("clamps out-of-range values into the supported range", () => {
    const result = mergeConfig({
      slicing: { maxSliceMinutes: 9999, maxTurnsPerSlice: 1, idleGapMinutes: 500 },
    });
    expect(result.slicing.maxSliceMinutes).toBe(240);
    expect(result.slicing.maxTurnsPerSlice).toBe(5);
    expect(result.slicing.idleGapMinutes).toBe(120);
  });

  it("clamps zero — an emptied input must not make every turn close the slice", () => {
    // idleGapMinutes: 0 would make checkIdleGap's `>=` always true (every turn
    // closes idle_gap, no carry-over); 0 on the other two force-closes the
    // same way. All clamp up to their minimums.
    const result = mergeConfig({
      slicing: { maxSliceMinutes: 0, maxTurnsPerSlice: 0, idleGapMinutes: 0 },
    });
    expect(result.slicing).toEqual({
      maxSliceMinutes: 5,
      maxTurnsPerSlice: 5,
      idleGapMinutes: 1,
    });
  });

  it("falls back to the DEFAULT (not the nearest bound) for non-finite/garbage values", () => {
    // NaN crosses the JSON round-trip as null and would otherwise be spread
    // over the default (`null * 60_000 === 0` even slips past the NaN guard).
    const result = mergeConfig({
      slicing: {
        maxSliceMinutes: NaN,
        maxTurnsPerSlice: null as unknown as number,
        idleGapMinutes: Infinity,
      },
    });
    expect(result.slicing).toEqual(DEFAULTS.slicing);
  });

  it("integerizes fractional input and keeps valid values untouched", () => {
    const result = mergeConfig({
      slicing: { maxSliceMinutes: 45.6, maxTurnsPerSlice: 50, idleGapMinutes: 15 },
    });
    expect(result.slicing.maxSliceMinutes).toBe(46);
    expect(result.slicing.maxTurnsPerSlice).toBe(50);
    expect(result.slicing.idleGapMinutes).toBe(15);
  });

  it("covers the save path too (mergeConfigOverrides funnels through mergeConfig)", () => {
    const result = mergeConfigOverrides(current, {
      slicing: { idleGapMinutes: -3 },
    });
    expect(result.slicing.idleGapMinutes).toBe(1);
    // Untouched siblings survive the round-trip.
    expect(result.slicing.maxSliceMinutes).toBe(30);
    expect(result.slicing.maxTurnsPerSlice).toBe(50);
  });
});
