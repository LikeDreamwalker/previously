import { describe, it, expect } from "vitest";
import {
  segmentSearch,
  textLines,
  searchResultToString,
  splitTurns,
  splitParagraphs,
} from "@/lib/retrieval/doc-segments";

describe("splitTurns", () => {
  it("splits a slice into frontmatter + one segment per turn", () => {
    const raw = [
      "---\nslice_id: x\n---",
      "## Turn 1 — 2026-07-24T10:00:00Z (user)",
      "hello",
      "## Turn 2 — 2026-07-24T10:01:00Z (agent)",
      "world",
    ].join("\n");
    const segs = splitTurns(raw);
    // Frontmatter is its own segment (carries summary/tags worth searching),
    // then one segment per turn.
    expect(segs).toHaveLength(3);
    expect(segs[0]).toContain("slice_id: x");
    expect(segs[1]).toContain("hello");
    expect(segs[2]).toContain("world");
  });
});

describe("splitParagraphs", () => {
  it("splits on blank lines", () => {
    const segs = splitParagraphs("para one\n\npara two\n\npara three");
    expect(segs).toEqual(["para one", "para two", "para three"]);
  });

  it("returns the whole text when no blank lines", () => {
    expect(splitParagraphs("single paragraph")).toEqual(["single paragraph"]);
  });
});

describe("segmentSearch", () => {
  const segments = [
    "we discussed rust async design",
    "then moved to sql queries",
    "sql migration planning",
    "frontend components",
  ];

  it("returns matching segments with context", () => {
    const hits = segmentSearch(segments, ["sql"], 1, 1);
    expect(hits).toHaveLength(1);
    // match is at index 1, context 1 before + 1 after → indices 0..2
    expect(hits[0].index).toBe(1);
    expect(hits[0].content).toContain("rust async design");
    expect(hits[0].content).toContain("sql migration planning");
  });

  it("is case-insensitive", () => {
    const hits = segmentSearch(segments, ["RUST"], 0, 0);
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(0);
  });

  it("returns empty when nothing matches", () => {
    expect(segmentSearch(segments, ["nope"], 1, 1)).toEqual([]);
  });

  it("returns empty for empty keywords or segments", () => {
    expect(segmentSearch([], ["sql"])).toEqual([]);
    expect(segmentSearch(segments, [])).toEqual([]);
    expect(segmentSearch(segments, ["  "])).toEqual([]);
  });

  it("dedupes overlapping hits into one window", () => {
    // Both index 1 and 2 match "sql" — with context 1, windows overlap → 1 hit.
    const hits = segmentSearch(segments, ["sql"], 1, 1);
    expect(hits).toHaveLength(1);
  });

  it("clamps context to document bounds", () => {
    const hits = segmentSearch(segments, ["frontend"], 5, 5);
    expect(hits).toHaveLength(1);
    // start clamped to 0, end clamped to 3 → whole doc in the window
    expect(hits[0].content).toContain("we discussed rust async design");
  });
});

describe("textLines", () => {
  const doc = "l1\nl2\nl3\nl4\nl5";

  it("returns an in-range slice", () => {
    const { content, clamped } = textLines(doc, 2, 4);
    expect(content).toBe("l2\nl3\nl4");
    expect(clamped).toBe(false);
  });

  it("returns a single line", () => {
    const { content } = textLines(doc, 3, 3);
    expect(content).toBe("l3");
  });

  it("clamps out-of-range end", () => {
    const { content, clamped } = textLines(doc, 4, 99);
    expect(content).toBe("l4\nl5");
    expect(clamped).toBe(true);
  });

  it("clamps start below 1", () => {
    const { content, clamped } = textLines(doc, -2, 2);
    expect(content).toBe("l1\nl2");
    expect(clamped).toBe(true);
  });

  it("returns empty for an invalid range (start > end)", () => {
    const { content, clamped } = textLines(doc, 4, 2);
    expect(content).toBe("");
    expect(clamped).toBe(true);
  });
});

describe("searchResultToString", () => {
  it("returns matched segments with a header", () => {
    const hits = segmentSearch(["a b c", "d e f"], ["b"], 0, 0);
    const s = searchResultToString("slice-1", ["b"], hits, "FULL");
    expect(s).toContain("Matched 1 segment");
    expect(s).toContain("a b c");
    expect(s).not.toContain("FULL");
  });

  it("degrades to full content with a note when nothing matches", () => {
    const hits = segmentSearch(["a b c"], ["zzz"], 0, 0);
    const s = searchResultToString("slice-1", ["zzz"], hits, "FULL-CONTENT");
    expect(s).toContain("No segments matched keywords [zzz]");
    expect(s).toContain("FULL-CONTENT");
  });

  it("caps the miss fallback at maxChars and says so", () => {
    // A keyword miss on a huge page must not flood the context with the
    // entire document — the fallback respects the caller's cap.
    const big = "x".repeat(100);
    const s = searchResultToString("example.com/p", ["zzz"], [], big, 15);
    expect(s).toContain("full content returned (truncated at 15 characters)");
    expect(s).toContain("x".repeat(15));
    expect(s).not.toContain("x".repeat(16));
  });

  it("leaves a small miss fallback intact when maxChars is given", () => {
    const s = searchResultToString("example.com/p", ["zzz"], [], "SHORT", 15);
    expect(s).toContain("full content returned:");
    expect(s).toContain("SHORT");
    expect(s).not.toContain("truncated");
  });
});
