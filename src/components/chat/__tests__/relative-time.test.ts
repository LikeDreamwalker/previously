import { describe, expect, it } from "vitest";
import { relativeBetween } from "../relative-time";

// Fixed UTC reference so the tier thresholds are deterministic everywhere.
const NOW = "2026-08-12T12:00:00Z";
const at = (deltaMs: number) =>
  new Date(Date.parse(NOW) + deltaMs).toISOString();

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const YEAR = 365 * DAY;

describe("relativeBetween", () => {
  it("returns null for invalid timestamps", () => {
    expect(relativeBetween("garbage", NOW)).toBeNull();
    expect(relativeBetween(NOW, "garbage")).toBeNull();
    expect(relativeBetween("", NOW)).toBeNull();
  });

  it("marks sub-5-minute deltas as moments, in both directions", () => {
    expect(relativeBetween(NOW, at(-2 * MINUTE))).toEqual({ kind: "moments", dir: "before" });
    expect(relativeBetween(NOW, at(2 * MINUTE))).toEqual({ kind: "moments", dir: "after" });
  });

  it("buckets minutes, hours, days, weeks, months, years", () => {
    expect(relativeBetween(NOW, at(-10 * MINUTE))).toEqual({
      kind: "count", dir: "before", unit: "minute", count: 10,
    });
    expect(relativeBetween(NOW, at(5 * HOUR))).toEqual({
      kind: "count", dir: "after", unit: "hour", count: 5,
    });
    expect(relativeBetween(NOW, at(-3 * DAY))).toEqual({
      kind: "count", dir: "before", unit: "day", count: 3,
    });
    expect(relativeBetween(NOW, at(10 * DAY))).toEqual({
      kind: "count", dir: "after", unit: "week", count: 1,
    });
    expect(relativeBetween(NOW, at(-60 * DAY))).toEqual({
      kind: "count", dir: "before", unit: "month", count: 2,
    });
    expect(relativeBetween(NOW, at(400 * DAY))).toEqual({
      kind: "count", dir: "after", unit: "year", count: 1,
    });
  });

  it("anchors the label to the FROM slice, not wall-clock now", () => {
    // Viewing a slice one year ago, then returning to "now" → "1 year later".
    expect(relativeBetween(at(-1 * YEAR), NOW)).toEqual({
      kind: "count", dir: "after", unit: "year", count: 1,
    });
    // And the reverse journey: now → a slice one year back → "1 year ago".
    expect(relativeBetween(NOW, at(-1 * YEAR))).toEqual({
      kind: "count", dir: "before", unit: "year", count: 1,
    });
    // Both slices in the past: the delta between THEM, not vs today.
    expect(relativeBetween(at(-10 * DAY), at(-7 * DAY))).toEqual({
      kind: "count", dir: "after", unit: "day", count: 3,
    });
  });

  it("resolves tier boundaries consistently", () => {
    expect(relativeBetween(NOW, at(-5 * MINUTE))).toEqual({
      kind: "count", dir: "before", unit: "minute", count: 5,
    });
    expect(relativeBetween(NOW, at(-1 * HOUR))).toEqual({
      kind: "count", dir: "before", unit: "hour", count: 1,
    });
    expect(relativeBetween(NOW, at(-7 * DAY))).toEqual({
      kind: "count", dir: "before", unit: "week", count: 1,
    });
    expect(relativeBetween(NOW, at(-35 * DAY))).toEqual({
      kind: "count", dir: "before", unit: "month", count: 1,
    });
    expect(relativeBetween(NOW, at(-1 * YEAR))).toEqual({
      kind: "count", dir: "before", unit: "year", count: 1,
    });
  });
});
