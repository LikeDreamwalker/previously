import { describe, it, expect } from "vitest";
import {
  searchCatalog,
  filterByWindow,
  filterByStrand,
  sortNewestFirst,
  queryKeyword,
} from "@/lib/search/slice-search";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

function makeEntry(
  id: string,
  over: Partial<TimelineSliceEntry> = {},
): TimelineSliceEntry {
  return {
    id,
    date: id.slice(0, 10),
    start: `${id.slice(0, 10)}T00:00:00Z`,
    status: "closed",
    focus: "",
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
    ...over,
  };
}

const catalog: TimelineSliceEntry[] = [
  makeEntry("2026-08-01-0900", {
    focus: "Plans the memory visualization milestone",
    summary: "Discussed the 3D timeline and the unified message stream.",
    tags: ["planning", "memory"],
    strands: ["memory-viz"],
  }),
  makeEntry("2026-08-02-1430", {
    focus: "Debugs the episodic slicer",
    summary: "Fixed a race in slice closing.",
    tags: ["debugging"],
    strands: ["slicing"],
  }),
  makeEntry("2026-08-03-1015", {
    focus: "Reviews the recall sub-agent",
    summary: "memory memory memory — the recall quota was tuned.",
    tags: ["review"],
    open_loops: ["Wire the memory card diff into housekeeping"],
    decisions: ["Keep memory quota at 8 slices"],
    strands: ["recall", "memory-viz"],
  }),
];

describe("searchCatalog", () => {
  it("returns [] for an empty query", () => {
    expect(searchCatalog(catalog, "")).toEqual([]);
    expect(searchCatalog(catalog, "   ")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchCatalog(catalog, "kubernetes")).toEqual([]);
  });

  it("matches case-insensitively and reports matchedFields with snippets", () => {
    const hits = searchCatalog(catalog, "MEMORY");
    const entry1 = hits.find((h) => h.entry.id === "2026-08-01-0900")!;
    expect(entry1.matchedFields).toEqual(["tags", "focus", "strands"]);
    const tagsMatch = entry1.matches.find((m) => m.field === "tags")!;
    expect(tagsMatch.snippets).toEqual(["memory"]);
  });

  it("weights tags > focus > summary > open_loops/decisions > strands", () => {
    const entries = [
      makeEntry("2026-08-01-0900", { strands: ["needle"] }),
      makeEntry("2026-08-01-0901", { decisions: ["needle"] }),
      makeEntry("2026-08-01-0902", { open_loops: ["needle"] }),
      makeEntry("2026-08-01-0903", { summary: "needle" }),
      makeEntry("2026-08-01-0904", { focus: "needle" }),
      makeEntry("2026-08-01-0905", { tags: ["needle"] }),
    ];
    const ids = searchCatalog(entries, "needle").map((h) => h.entry.id);
    expect(ids).toEqual([
      "2026-08-01-0905", // tags (5)
      "2026-08-01-0904", // focus (4)
      "2026-08-01-0903", // summary (3)
      "2026-08-01-0902", // open_loops (2) — tie with decisions, newer id wins
      "2026-08-01-0901", // decisions (2)
      "2026-08-01-0900", // strands (1)
    ]);
  });

  it("weights hit count: more occurrences in the same field score higher", () => {
    const hits = searchCatalog(catalog, "memory");
    const repeated = hits.find((h) => h.entry.id === "2026-08-03-1015")!;
    // summary has 3 occurrences (3×3) + open_loops 1 (2) + decisions 1 (2)
    // + strands 1 (1) = 14 — beats entry 1's summary 1 + tags 1 + strands 1 = 9.
    expect(repeated.score).toBe(3 * 3 + 2 + 2 + 1);
    expect(hits[0].entry.id).toBe("2026-08-03-1015");
  });

  it("counts each matching array item once", () => {
    const entries = [
      makeEntry("2026-08-01-0900", { tags: ["needle-a", "needle-b"] }),
      makeEntry("2026-08-01-0901", { tags: ["needle-a"] }),
    ];
    const hits = searchCatalog(entries, "needle");
    expect(hits[0].entry.id).toBe("2026-08-01-0900");
    expect(hits[0].score).toBe(10);
    expect(hits[1].score).toBe(5);
  });

  it("extracts windowed snippets with ellipses from long string fields", () => {
    const pad = "x".repeat(60);
    const entries = [
      makeEntry("2026-08-01-0900", { summary: `${pad}needle${pad}` }),
    ];
    const [hit] = searchCatalog(entries, "needle");
    const snippet = hit.matches[0].snippets[0];
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
  });

  it("breaks score ties newest-first by id", () => {
    const entries = [
      makeEntry("2026-08-01-0900", { focus: "needle" }),
      makeEntry("2026-08-02-0900", { focus: "needle" }),
    ];
    const hits = searchCatalog(entries, "needle");
    expect(hits.map((h) => h.entry.id)).toEqual([
      "2026-08-02-0900",
      "2026-08-01-0900",
    ]);
  });

  describe("#strand syntax", () => {
    it("filters by strand and searches the rest as keyword", () => {
      const hits = searchCatalog(catalog, "#memory-viz memory");
      // Only slices carrying memory-viz, keyword "memory" applied within.
      expect(hits.map((h) => h.entry.id)).toEqual([
        "2026-08-03-1015",
        "2026-08-01-0900",
      ]);
    });

    it("matches the strand name case-insensitively", () => {
      const hits = searchCatalog(catalog, "#Memory-Viz memory");
      expect(hits).toHaveLength(2);
    });

    it("treats a strand-only query as a pure filter (score 0, newest first)", () => {
      const hits = searchCatalog(catalog, "#memory-viz");
      expect(hits.map((h) => h.entry.id)).toEqual([
        "2026-08-03-1015",
        "2026-08-01-0900",
      ]);
      expect(hits.every((h) => h.score === 0)).toBe(true);
      expect(hits[0].matchedFields).toEqual(["strands"]);
      expect(hits[0].matches[0].snippets).toEqual(["memory-viz"]);
    });

    it("returns [] when the strand matches nothing", () => {
      expect(searchCatalog(catalog, "#nope memory")).toEqual([]);
    });

    it("ignores a bare # token", () => {
      // "#" alone is dropped; "memory" still runs as the keyword.
      expect(searchCatalog(catalog, "# memory")).toHaveLength(2);
    });
  });
});

describe("filterByWindow", () => {
  it("keeps entries inside the inclusive window (id date semantics)", () => {
    const out = filterByWindow(catalog, "2026-08-02", "2026-08-03");
    expect(out.map((s) => s.id)).toEqual(["2026-08-02-1430", "2026-08-03-1015"]);
  });

  it("supports open-ended bounds", () => {
    expect(filterByWindow(catalog, "2026-08-02").map((s) => s.id)).toEqual([
      "2026-08-02-1430",
      "2026-08-03-1015",
    ]);
    expect(filterByWindow(catalog, undefined, "2026-08-01").map((s) => s.id)).toEqual([
      "2026-08-01-0900",
    ]);
  });

  it("returns everything when both bounds are omitted", () => {
    expect(filterByWindow(catalog)).toHaveLength(catalog.length);
  });

  it("returns [] for an empty window", () => {
    expect(filterByWindow(catalog, "2030-01-01", "2030-01-02")).toEqual([]);
  });
});

describe("filterByStrand", () => {
  it("keeps only entries carrying the strand", () => {
    expect(filterByStrand(catalog, "recall").map((s) => s.id)).toEqual([
      "2026-08-03-1015",
    ]);
  });

  it("matches case-insensitively and rejects blank names", () => {
    expect(filterByStrand(catalog, "RECALL")).toHaveLength(1);
    expect(filterByStrand(catalog, "  ")).toEqual([]);
  });
});

describe("sortNewestFirst", () => {
  it("orders by id descending without mutating the input", () => {
    const input = [
      makeEntry("2026-08-01-0900"),
      makeEntry("2026-08-03-1015"),
      makeEntry("2026-08-02-1430"),
    ];
    const out = sortNewestFirst(input);
    expect(out.map((s) => s.id)).toEqual([
      "2026-08-03-1015",
      "2026-08-02-1430",
      "2026-08-01-0900",
    ]);
    // Input untouched.
    expect(input[0].id).toBe("2026-08-01-0900");
  });
});

describe("queryKeyword", () => {
  it("strips #strand tokens and keeps the keyword", () => {
    expect(queryKeyword("memory #recall #memory-viz")).toBe("memory");
    expect(queryKeyword("#recall")).toBe("");
    expect(queryKeyword("# memory")).toBe("memory"); // bare # is dropped
  });
});
