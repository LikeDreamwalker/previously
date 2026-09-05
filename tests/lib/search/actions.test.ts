import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

const store = vi.hoisted(() => ({ readTimelineIndex: vi.fn() }));
vi.mock("@/lib/episodic/timeline/store", () => ({
  readTimelineIndex: store.readTimelineIndex,
}));

import { searchSlices } from "@/lib/search/actions";

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

const slices = [
  makeEntry("2026-08-01-0900", { focus: "needle in focus", tags: ["a"] }),
  makeEntry("2026-08-05-0900", { focus: "needle later", strands: ["s1"] }),
];

beforeEach(() => {
  store.readTimelineIndex.mockReset();
  store.readTimelineIndex.mockResolvedValue({
    _schema: 1,
    updated_at: "2026-08-06T00:00:00Z",
    slice_count: slices.length,
    needs_marking: 0,
    slices,
  });
});

describe("searchSlices", () => {
  it("returns [] when the catalog is not built yet", async () => {
    store.readTimelineIndex.mockResolvedValue(null);
    expect(await searchSlices("needle")).toEqual([]);
  });

  it("searches the full catalog without opts", async () => {
    const hits = await searchSlices("needle");
    expect(hits).toHaveLength(2);
    expect(hits[0].entry.id).toBe("2026-08-05-0900"); // tie → newest first
  });

  it("applies the date window before scoring", async () => {
    const hits = await searchSlices("needle", { to: "2026-08-02" });
    expect(hits.map((h) => h.entry.id)).toEqual(["2026-08-01-0900"]);
  });

  it("supports the #strand syntax through the action", async () => {
    const hits = await searchSlices("#s1 needle");
    expect(hits.map((h) => h.entry.id)).toEqual(["2026-08-05-0900"]);
  });
});
