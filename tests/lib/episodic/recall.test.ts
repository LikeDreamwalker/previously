import { describe, it, expect } from "vitest";
import {
  normalizeRecommendedReads,
  excludeCurrentSlice,
} from "@/lib/episodic/flash/recall";

describe("normalizeRecommendedReads", () => {
  it("passes through well-formed reads", () => {
    const result = normalizeRecommendedReads([
      { slice_id: "2026-07-24-1500", priority: "high", reason: "Direct match", note: "See the decision" },
      { slice_id: "2026-06-10-0900", priority: "low", reason: "Tangential" },
    ]);
    expect(result).toEqual([
      { slice_id: "2026-07-24-1500", priority: "high", reason: "Direct match", note: "See the decision" },
      { slice_id: "2026-06-10-0900", priority: "low", reason: "Tangential", note: undefined },
    ]);
  });

  it("defaults an unknown or missing priority to medium", () => {
    const result = normalizeRecommendedReads([
      { slice_id: "2026-07-24-1500", reason: "No priority" },
      { slice_id: "2026-07-24-1501", priority: "urgent", reason: "Invalid priority" },
    ]);
    expect(result.map((r) => r.priority)).toEqual(["medium", "medium"]);
  });

  it("drops entries without a usable slice_id", () => {
    const result = normalizeRecommendedReads([
      { slice_id: "", priority: "high", reason: "empty id" },
      { slice_id: undefined, priority: "high", reason: "missing id" },
      { slice_id: 42 as unknown as string, priority: "high", reason: "wrong type" },
      { slice_id: "2026-07-24-1500", priority: "high", reason: "valid" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.slice_id).toBe("2026-07-24-1500");
  });

  it("caps at 5 reads", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      slice_id: `2026-07-24-${String(1500 + i)}`,
      reason: `entry ${i}`,
    }));
    expect(normalizeRecommendedReads(many)).toHaveLength(5);
  });

  it("defaults a missing reason to empty string and drops empty notes", () => {
    const result = normalizeRecommendedReads([
      { slice_id: "2026-07-24-1500", reason: undefined, note: "" },
    ]);
    expect(result).toEqual([
      { slice_id: "2026-07-24-1500", priority: "medium", reason: "", note: undefined },
    ]);
  });

  it("returns an empty array for undefined input", () => {
    expect(normalizeRecommendedReads(undefined)).toEqual([]);
  });
});

describe("excludeCurrentSlice", () => {
  it("drops the current slice from hits", () => {
    const hits = [
      { slice_id: "2026-07-24-1500", relevance: 0.9, reason: "past", key_turns: [2] },
      { slice_id: "2026-08-05-1644", relevance: 0.8, reason: "current", key_turns: [0] },
      { slice_id: "2026-06-10-0900", relevance: 0.5, reason: "past", key_turns: [] },
    ];
    const result = excludeCurrentSlice(hits, "2026-08-05-1644");
    expect(result.map((h) => h.slice_id)).toEqual([
      "2026-07-24-1500",
      "2026-06-10-0900",
    ]);
  });

  it("drops the current slice from recommended reads", () => {
    const reads = [
      { slice_id: "2026-08-05-1644", priority: "high", reason: "self-match" },
      { slice_id: "2026-07-24-1500", priority: "medium", reason: "real match" },
    ];
    const result = excludeCurrentSlice(reads, "2026-08-05-1644");
    expect(result.map((r) => r.slice_id)).toEqual(["2026-07-24-1500"]);
  });

  it("leaves results untouched when the current slice id is empty", () => {
    const hits = [{ slice_id: "2026-07-24-1500", relevance: 0.9, reason: "x", key_turns: [] }];
    expect(excludeCurrentSlice(hits, "")).toEqual(hits);
  });

  it("returns an empty array when every hit is the current slice", () => {
    const hits = [{ slice_id: "2026-08-05-1644", relevance: 0.9, reason: "self", key_turns: [0] }];
    expect(excludeCurrentSlice(hits, "2026-08-05-1644")).toEqual([]);
  });
});
