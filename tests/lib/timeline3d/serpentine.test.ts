import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  serpentineGrid,
  partitionRegions,
  isoWeek,
  rowPitch,
  gridWidth,
  type SerpentineGridConfig,
} from "@/lib/timeline3d/serpentine";

const CFG: SerpentineGridConfig = {
  cardW: 2,
  cardH: 1,
  gapX: 0.5,
  gapY: 0.5,
  perRow: 4,
};

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

describe("serpentineGrid", () => {
  it("lays cards out in strict chronological serpentine order", () => {
    // 12 cards, 4 per row: rows 1234 / 8765 / 9 10 11 12.
    const g = serpentineGrid(12, CFG);
    expect(g.rows).toBe(3);
    // Row 0 (even, L→R): cols 0,1,2,3 ascending x.
    for (let i = 0; i < 4; i++) {
      expect(g.cards[i].row).toBe(0);
      expect(g.cards[i].col).toBe(i);
    }
    // Row 1 (odd, R→L): traversal 4..7 → cols 3,2,1,0 — card 5 (index 4)
    // sits directly under card 4 (index 3).
    expect(g.cards[4].col).toBe(3);
    expect(g.cards[4].x).toBe(g.cards[3].x);
    expect(g.cards[7].col).toBe(0);
    // Row 2 (even, L→R) again: index 8 under index 7.
    expect(g.cards[8].col).toBe(0);
    expect(g.cards[8].x).toBe(g.cards[7].x);
    expect(g.cards[11].col).toBe(3);
    // yDown strictly increases per row.
    expect(g.cards[4].y).toBeGreaterThan(g.cards[0].y);
    expect(g.cards[8].y).toBeGreaterThan(g.cards[4].y);
  });

  it("right-aligns a partial odd last row (card 5 under card 4)", () => {
    const g = serpentineGrid(6, CFG); // rows: 1234 / 65
    expect(g.rows).toBe(2);
    expect(g.cards[4].col).toBe(3); // under card 4
    expect(g.cards[5].col).toBe(2); // under card 3
  });

  it("handles a single card and zero cards", () => {
    const one = serpentineGrid(1, CFG);
    expect(one.cards).toHaveLength(1);
    expect(one.rows).toBe(1);
    expect(one.highway).toEqual([[CFG.cardW / 2, 0]]);
    const zero = serpentineGrid(0, CFG);
    expect(zero.cards).toEqual([]);
    expect(zero.rows).toBe(0);
    expect(zero.highway).toEqual([]);
  });

  it("highway alternates direction with U-turn midpoints between rows", () => {
    const g = serpentineGrid(12, CFG);
    // 12 cards + 2 U-turn midpoints = 14 points.
    expect(g.highway).toHaveLength(14);
    const pitch = rowPitch(CFG);
    // U-turn after index 3 (end of even row 0): right of the grid, midway down.
    const u1 = g.highway[4];
    expect(u1[0]).toBeGreaterThan(gridWidth(CFG));
    expect(u1[1]).toBeCloseTo(pitch / 2, 10);
    // U-turn after index 7 (end of odd row 1): left of the grid.
    const u2 = g.highway[9];
    expect(u2[0]).toBeLessThan(0);
    expect(u2[1]).toBeCloseTo(pitch + pitch / 2, 10);
  });
});

describe("isoWeek", () => {
  it("computes ISO 8601 weeks (Monday start), local time", () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeek(new Date(2026, 0, 1))).toEqual([2026, 1]);
    // 2025-12-29 (Monday) belongs to ISO week 1 of 2026.
    expect(isoWeek(new Date(2025, 11, 29))).toEqual([2026, 1]);
    // 2026-08-17 (Monday) → week 34.
    expect(isoWeek(new Date(2026, 7, 17))).toEqual([2026, 34]);
  });
});

describe("partitionRegions", () => {
  // Local-time ISO strings (no Z suffix) — grouping is local-time, so these
  // parse identically in any machine timezone.
  it("groups by day in chronological order", () => {
    const regions = partitionRegions(
      [
        entry("2026-08-17T01:21:00"),
        entry("2026-08-17T14:02:00"),
        entry("2026-08-19T20:11:00"),
      ],
      "day",
    );
    expect(regions.map((r) => r.key)).toEqual(["2026-08-17", "2026-08-19"]);
    expect(regions[0].entries).toHaveLength(2);
    expect(regions[1].entries).toHaveLength(1);
  });

  it("groups by ISO week with Monday–Sunday labels", () => {
    const regions = partitionRegions(
      [
        entry("2026-08-15T10:00:00"), // Saturday, week of 08-10
        entry("2026-08-17T01:21:00"), // Monday, week of 08-17
      ],
      "week",
    );
    expect(regions).toHaveLength(2);
    expect(regions[0].label).toBe("08-10 – 08-16");
    expect(regions[1].label).toBe("08-17 – 08-23");
    expect(regions[1].key).toBe("2026-W34");
  });

  it("groups by hour", () => {
    const regions = partitionRegions(
      [
        entry("2026-08-17T01:21:00"),
        entry("2026-08-17T01:55:00"),
        entry("2026-08-17T02:05:00"),
      ],
      "hour",
    );
    expect(regions.map((r) => r.key)).toEqual([
      "2026-08-17T01",
      "2026-08-17T02",
    ]);
    expect(regions[0].entries).toHaveLength(2);
    expect(regions[0].label).toBe("08-17 01:00");
  });

  it("returns no regions for an empty catalog", () => {
    expect(partitionRegions([], "week")).toEqual([]);
  });
});
