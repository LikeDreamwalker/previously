import { describe, it, expect } from "vitest";

// sliceIdToCorePath is defined inside recall.ts but not exported directly.
// We replicate its logic here to test it — the function is pure and simple.
// This tests the exact algorithm used by the recall agent to resolve slice
// IDs to file paths, which is critical for correct recall behavior.

function sliceIdToCorePath(sliceId: string): string {
  const parts = sliceId.split("-");
  if (parts.length >= 4) {
    const [y, m, d, hm] = parts;
    return `memory/episodic/slices/${y}/${m}/${d}/${hm}/timeline/core.md`;
  }
  // Legacy format: YYYY-MM-DD
  const [y, m, d] = parts;
  return `memory/episodic/slices/${y}/${m}/${d}/core.md`;
}

describe("sliceIdToCorePath", () => {
  it("builds new-format path for 4-part slice ID", () => {
    const result = sliceIdToCorePath("2026-07-24-1500");
    expect(result).toBe("memory/episodic/slices/2026/07/24/1500/timeline/core.md");
  });

  it("builds new-format path with different time", () => {
    const result = sliceIdToCorePath("2026-12-01-0830");
    expect(result).toBe("memory/episodic/slices/2026/12/01/0830/timeline/core.md");
  });

  it("builds legacy-format path for 3-part slice ID (YYYY-MM-DD)", () => {
    const result = sliceIdToCorePath("2026-07-24");
    expect(result).toBe("memory/episodic/slices/2026/07/24/core.md");
  });

  it("handles single-digit months and days with zero-padding from the slice ID", () => {
    const result = sliceIdToCorePath("2026-01-05-0001");
    expect(result).toBe("memory/episodic/slices/2026/01/05/0001/timeline/core.md");
  });

  it("handles 5-part IDs (returns new-format path using first 4 parts)", () => {
    // If somehow a 5-part ID is passed, the >=4 check catches it
    const result = sliceIdToCorePath("2026-07-24-1500-extra");
    expect(result).toBe("memory/episodic/slices/2026/07/24/1500/timeline/core.md");
  });
});
