import { describe, it, expect } from "vitest";
import {
  createSliceReadQuota,
  excludeCurrentSlice,
  MAX_SLICE_READS,
} from "@/lib/episodic/flash/recall";

describe("createSliceReadQuota", () => {
  it("allows exactly `max` full reads, then refuses", () => {
    const quota = createSliceReadQuota(2);
    expect(quota.tryTake()).toBe(true);
    expect(quota.tryTake()).toBe(true);
    expect(quota.tryTake()).toBe(false);
    expect(quota.used).toBe(2);
    expect(quota.max).toBe(2);
  });

  it("a refused take does not consume a slot", () => {
    const quota = createSliceReadQuota(1);
    expect(quota.tryTake()).toBe(true);
    expect(quota.tryTake()).toBe(false);
    expect(quota.tryTake()).toBe(false);
    expect(quota.used).toBe(1);
  });

  it("defaults to the run's MAX_SLICE_READS", () => {
    const quota = createSliceReadQuota();
    expect(quota.max).toBe(MAX_SLICE_READS);
    for (let i = 0; i < MAX_SLICE_READS; i++) {
      expect(quota.tryTake()).toBe(true);
    }
    expect(quota.tryTake()).toBe(false);
  });

  it("instances are independent (no shared state between runs)", () => {
    const a = createSliceReadQuota(1);
    const b = createSliceReadQuota(1);
    expect(a.tryTake()).toBe(true);
    expect(a.tryTake()).toBe(false);
    expect(b.tryTake()).toBe(true);
  });
});

describe("excludeCurrentSlice", () => {
  it("drops the current slice from references", () => {
    const refs = [
      { slice_id: "2026-07-24-1500", quote: "past", note: "backs X" },
      { slice_id: "2026-08-05-1644", quote: "current", note: "backs Y" },
      { slice_id: "2026-06-10-0900", quote: "past", note: "backs Z" },
    ];
    const result = excludeCurrentSlice(refs, "2026-08-05-1644");
    expect(result.map((r) => r.slice_id)).toEqual([
      "2026-07-24-1500",
      "2026-06-10-0900",
    ]);
  });

  it("leaves results untouched when the current slice id is empty", () => {
    const refs = [{ slice_id: "2026-07-24-1500", quote: "x", note: "" }];
    expect(excludeCurrentSlice(refs, "")).toEqual(refs);
  });

  it("returns an empty array when every reference is the current slice", () => {
    const refs = [{ slice_id: "2026-08-05-1644", quote: "self", note: "" }];
    expect(excludeCurrentSlice(refs, "2026-08-05-1644")).toEqual([]);
  });
});
