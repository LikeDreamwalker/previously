import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { pageCatalog } from "@/lib/episodic/timeline/paginate";

let seq = 0;
function entry(start: string): TimelineSliceEntry {
  seq += 1;
  return {
    id: `s${seq}`,
    date: start.slice(0, 10),
    start,
    status: "closed",
    focus: "f",
    summary: "s",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
  };
}

describe("pageCatalog", () => {
  it("takes the newest N distinct months, oldest → newest", () => {
    const all = [
      entry("2026-06-02T10:00:00"),
      entry("2026-07-05T10:00:00"),
      entry("2026-07-20T10:00:00"),
      entry("2026-08-11T10:00:00"),
      entry("2026-08-17T10:00:00"),
    ];
    const page = pageCatalog(all, null, 2);
    expect(page.entries.map((e) => e.date)).toEqual([
      "2026-07-05",
      "2026-07-20",
      "2026-08-11",
      "2026-08-17",
    ]);
    expect(page.oldestMonth).toBe("2026-07");
    expect(page.hasMore).toBe(true);
  });

  it("pages strictly older than `before` (no overlap between pages)", () => {
    const all = [
      entry("2026-06-02T10:00:00"),
      entry("2026-06-28T10:00:00"),
      entry("2026-07-05T10:00:00"),
      entry("2026-08-11T10:00:00"),
    ];
    const first = pageCatalog(all, null, 1);
    expect(first.entries.map((e) => e.date)).toEqual(["2026-08-11"]);
    const second = pageCatalog(all, first.oldestMonth, 1);
    expect(second.entries.map((e) => e.date)).toEqual(["2026-07-05"]);
    expect(second.hasMore).toBe(true);
    const third = pageCatalog(all, second.oldestMonth, 1);
    expect(third.entries.map((e) => e.date)).toEqual([
      "2026-06-02",
      "2026-06-28",
    ]);
    expect(third.hasMore).toBe(false);
  });

  it("reports hasMore=false when the page reaches the oldest entry", () => {
    const all = [entry("2026-08-11T10:00:00")];
    const page = pageCatalog(all, null, 3);
    expect(page.hasMore).toBe(false);
    expect(page.oldestMonth).toBe("2026-08");
  });

  it("returns an empty page when nothing is older than `before`", () => {
    const all = [entry("2026-08-11T10:00:00")];
    const page = pageCatalog(all, "2026-08", 2);
    expect(page.entries).toEqual([]);
    expect(page.oldestMonth).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it("sorts defensively when the catalog is out of order", () => {
    const all = [
      entry("2026-08-11T10:00:00"),
      entry("2026-06-02T10:00:00"),
      entry("2026-07-05T10:00:00"),
    ];
    const page = pageCatalog(all, null, 2);
    expect(page.entries.map((e) => e.date)).toEqual([
      "2026-07-05",
      "2026-08-11",
    ]);
  });
});
