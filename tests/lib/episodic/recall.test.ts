import { describe, it, expect } from "vitest";
import { normalizeRecommendedReads } from "@/lib/episodic/flash/recall";

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
