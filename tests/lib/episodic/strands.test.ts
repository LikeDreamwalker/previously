import { describe, it, expect } from "vitest";
import {
  normalizeStrandKey,
  findMatchingStrand,
  weaveTag,
  applyStrandMerges,
  pruneStrands,
  slicePathToMs,
} from "@/lib/episodic/strands";

describe("normalizeStrandKey", () => {
  it("trims and lowercases ASCII", () => {
    expect(normalizeStrandKey("  Apex ")).toBe("apex");
  });

  it("maps full-width to half-width", () => {
    expect(normalizeStrandKey("Ａｐｅｘ")).toBe("apex");
  });

  it("collapses inner whitespace runs", () => {
    expect(normalizeStrandKey("plan   b")).toBe("plan b");
  });

  it("leaves Chinese keys untouched", () => {
    expect(normalizeStrandKey("  心态调整  ")).toBe("心态调整");
  });
});

describe("findMatchingStrand", () => {
  it("returns the existing key for a normalized-equivalent tag (casing)", () => {
    const strands = { Apex: ["2026/08/02/1444"] };
    expect(findMatchingStrand(strands, "apex")).toBe("Apex");
  });

  it("returns null when no normalized match exists", () => {
    const strands = { Apex: ["2026/08/02/1444"] };
    expect(findMatchingStrand(strands, "面试")).toBeNull();
  });
});

describe("weaveTag", () => {
  it("merges a normalized-equivalent tag into the existing strand (no new key)", () => {
    const strands = { Apex: ["2026/08/02/1444"] };
    const { key, created } = weaveTag(strands, "apex", "2026/08/03/1310");
    expect(key).toBe("Apex");
    expect(created).toBe(false);
    expect(strands).toEqual({
      Apex: ["2026/08/02/1444", "2026/08/03/1310"],
    });
  });

  it("creates a new normalized key when the tag is genuinely new", () => {
    const strands: Record<string, string[]> = { Apex: ["2026/08/02/1444"] };
    const { key, created } = weaveTag(strands, "面试复盘", "2026/08/03/1310");
    expect(key).toBe("面试复盘");
    expect(created).toBe(true);
    expect(strands["面试复盘"]).toEqual(["2026/08/03/1310"]);
  });

  it("deduplicates slice paths under the same key", () => {
    const strands: Record<string, string[]> = {};
    weaveTag(strands, "rust", "2026/06/22/1400");
    weaveTag(strands, "rust", "2026/06/22/1400");
    expect(strands.rust).toEqual(["2026/06/22/1400"]);
  });
});

describe("applyStrandMerges", () => {
  it("unions path lists and removes the from key", () => {
    const strands = {
      陈勇超: ["2026/08/02/0952"],
      陈永超: ["2026/08/02/1050", "2026/08/03/0510"],
    };
    const { applied } = applyStrandMerges(strands, [
      { from: "陈勇超", to: "陈永超" },
    ]);
    expect(applied).toBe(1);
    expect(strands).toEqual({
      陈永超: ["2026/08/02/1050", "2026/08/03/0510", "2026/08/02/0952"],
    });
  });

  it("merges onto a normalized target even with casing drift", () => {
    const strands = {
      apex: ["2026/08/02/1444"],
      Apex: ["2026/08/03/1310"],
    };
    applyStrandMerges(strands, [{ from: "Apex", to: "apex" }]);
    expect(strands.apex.sort()).toEqual([
      "2026/08/02/1444",
      "2026/08/03/1310",
    ]);
    expect(strands.Apex).toBeUndefined();
  });

  it("ignores a from key that does not exist", () => {
    const strands = { Apex: ["2026/08/02/1444"] };
    const { applied } = applyStrandMerges(strands, [
      { from: "不存在", to: "Apex" },
    ]);
    expect(applied).toBe(0);
    expect(strands).toEqual({ Apex: ["2026/08/02/1444"] });
  });
});

describe("slicePathToMs", () => {
  it("parses a valid slice path", () => {
    const ms = slicePathToMs("2026/08/07/0733");
    expect(ms).not.toBeNull();
    expect(Number.isNaN(Number(ms))).toBe(false);
  });

  it("returns null for a malformed path", () => {
    expect(slicePathToMs("not-a-path")).toBeNull();
  });
});

describe("pruneStrands", () => {
  const now = Date.UTC(2026, 7, 7, 12, 0); // 2026-08-07 12:00 UTC
  const oldSlice = "2026/07/01/0800";
  const recentSlice = "2026/08/06/0800";

  it("prunes a single-slice strand whose only slice is stale", () => {
    const strands = {
      一次性事件: [oldSlice],
      长期主题: [oldSlice, "2026/07/02/0800"], // two slices → kept
    };
    const { pruned } = pruneStrands(strands, { nowMs: now });
    expect(pruned).toEqual(["一次性事件"]);
    expect(pruned.includes("长期主题")).toBe(false);
  });

  it("keeps a single-slice strand that has a recent slice", () => {
    const strands = { 新主题: [recentSlice] };
    const { pruned } = pruneStrands(strands, { nowMs: now });
    expect(pruned).toEqual([]);
  });

  it("respects a custom maxSliceAgeMs", () => {
    const strands = { 旧事件: [oldSlice] };
    const { pruned } = pruneStrands(strands, {
      nowMs: now,
      maxSliceAgeMs: 90 * 24 * 60 * 60 * 1000,
    });
    expect(pruned).toEqual([]); // within 90 days → kept
  });

  it("returns the pruned key removed from the kept index", () => {
    const strands = { 一次性事件: [oldSlice] };
    const { strands: kept } = pruneStrands(strands, { nowMs: now });
    expect(kept["一次性事件"]).toBeUndefined();
  });
});
