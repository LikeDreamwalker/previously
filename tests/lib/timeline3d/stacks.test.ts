import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  CARD_RATIO,
  DEFAULT_LEVEL,
  MAX_SHELLS,
  backingSheets,
  cardGeometryFor,
  densityTier,
  filterByStrand,
  frameGeometryFor,
  framePitchFor,
  groupForLevel,
  indexForAnchor,
  rowKeyFor,
  rowPitchFor,
  sheetPose,
  shellPose,
} from "@/lib/timeline3d/stacks";

let seq = 0;
function entry(
  iso: string,
  over: Partial<TimelineSliceEntry> = {},
): TimelineSliceEntry {
  seq += 1;
  const date = iso.slice(0, 10);
  const hm = iso.slice(11, 16).replace(":", "");
  return {
    id: `${date}-${hm}`,
    date,
    start: iso,
    turn_count: 2,
    status: "closed",
    focus: `focus ${seq}`,
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
    ...over,
  };
}

describe("rowKeyFor", () => {
  const e = entry("2024-08-17T01:21:00.000Z");
  it("keys by slice id / day / month", () => {
    expect(rowKeyFor(e, 0)).toBe("2024-08-17-0121");
    expect(rowKeyFor(e, 1)).toBe("d:2024-08-17");
    expect(rowKeyFor(e, 2)).toBe("m:2024-08");
  });
});

describe("groupForLevel", () => {
  const entries = [
    entry("2024-08-17T01:21:00.000Z", { strands: ["running"] }),
    entry("2024-08-17T09:00:00.000Z", { strands: ["work"] }),
    entry("2024-08-18T10:00:00.000Z", { strands: ["running"] }),
    entry("2024-09-01T08:00:00.000Z"),
  ];

  it("L0 keeps one entry per row, oldest first", () => {
    const rows = groupForLevel(entries, 0);
    expect(rows).toHaveLength(4);
    expect(rows[0].top.id).toBe("2024-08-17-0121");
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it("L1 stacks same-day slices with the NEWEST on top", () => {
    const rows = groupForLevel(entries, 1);
    expect(rows).toHaveLength(3);
    expect(rows[0].key).toBe("d:2024-08-17");
    expect(rows[0].count).toBe(2);
    expect(rows[0].top.id).toBe("2024-08-17-0900");
    expect(rows[0].strands).toEqual(["running", "work"]);
  });

  it("L2 stacks by month", () => {
    const rows = groupForLevel(entries, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("m:2024-08");
    expect(rows[0].count).toBe(3);
    expect(rows[1].key).toBe("m:2024-09");
  });

  it("sorts defensively when input is unordered", () => {
    const rows = groupForLevel([entries[2], entries[0], entries[1]], 1);
    expect(rows.map((r) => r.key)).toEqual(["d:2024-08-17", "d:2024-08-18"]);
  });

  it("handles an empty catalog", () => {
    expect(groupForLevel([], 1)).toEqual([]);
  });
});

describe("densityTier", () => {
  it("maps count to shell layers", () => {
    expect(densityTier(1)).toBe(0);
    expect(densityTier(2)).toBe(1);
    expect(densityTier(4)).toBe(1);
    expect(densityTier(5)).toBe(2);
    expect(densityTier(12)).toBe(2);
    expect(densityTier(13)).toBe(3);
    expect(densityTier(700)).toBe(MAX_SHELLS);
  });
});

describe("shellPose", () => {
  it("is deterministic for the same group + shell index", () => {
    expect(shellPose("d:2024-08-17", 0)).toEqual(shellPose("d:2024-08-17", 0));
    expect(shellPose("d:2024-08-17", 0)).not.toEqual(
      shellPose("d:2024-08-17", 1),
    );
  });

  it("stays inside the askew-but-tidy envelope", () => {
    for (let i = 0; i < MAX_SHELLS; i++) {
      for (const key of ["a", "b", "c", "m:2024-08"]) {
        const p = shellPose(key, i);
        expect(Math.abs(p.rotate)).toBeGreaterThanOrEqual(0.5);
        expect(Math.abs(p.rotate)).toBeLessThanOrEqual(1.4);
        expect(Math.abs(p.offsetX)).toBeGreaterThanOrEqual(3);
        expect(p.offsetY).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("indexForAnchor", () => {
  const entries = [
    entry("2024-08-17T01:21:00.000Z"),
    entry("2024-08-17T09:00:00.000Z"),
    entry("2024-08-18T10:00:00.000Z"),
  ];

  it("finds the row containing the anchor entry (any level)", () => {
    const days = groupForLevel(entries, 1);
    // Anchored on the OLDER member of the 08-17 stack → that stack.
    expect(indexForAnchor(days, "2024-08-17-0121")).toBe(0);
    const months = groupForLevel(entries, 2);
    expect(indexForAnchor(months, "2024-08-18-1000")).toBe(0);
  });

  it("falls back to the nearest row by time when the entry is gone (filter)", () => {
    const days = groupForLevel(entries.slice(2), 1); // only 08-18 remains
    expect(indexForAnchor(days, "2024-08-17-0121")).toBe(0);
  });

  it("returns -1 for empty rows", () => {
    expect(indexForAnchor([], "2024-08-17-0121")).toBe(-1);
  });
});

describe("filterByStrand", () => {
  const entries = [
    entry("2024-08-17T01:21:00.000Z", { strands: ["running"] }),
    entry("2024-08-18T10:00:00.000Z", { strands: ["work", "running"] }),
    entry("2024-08-19T10:00:00.000Z", { strands: ["work"] }),
  ];

  it("null keeps everything (核心时间线)", () => {
    expect(filterByStrand(entries, null)).toBe(entries);
  });

  it("keeps only carriers of the strand", () => {
    expect(filterByStrand(entries, "running")).toHaveLength(2);
    expect(filterByStrand(entries, "work")).toHaveLength(2);
    expect(filterByStrand(entries, "nope")).toHaveLength(0);
  });
});

describe("level constants", () => {
  it("lands on day stacks", () => {
    expect(DEFAULT_LEVEL).toBe(1);
  });
});

describe("cardGeometryFor", () => {
  it("uses responsive width tiers", () => {
    expect(cardGeometryFor(1600).cardW).toBe(380);
    expect(cardGeometryFor(800).cardW).toBe(340);
    const mobile = cardGeometryFor(390);
    expect(mobile.cardW).toBe(302); // 390 - 88
    expect(cardGeometryFor(300).cardW).toBe(260); // clamped
  });

  it("keeps the card aspect and derives row pitch", () => {
    const geo = cardGeometryFor(1600);
    expect(geo.cardH).toBe(Math.round(geo.cardW / CARD_RATIO));
    expect(rowPitchFor(0, geo)).toBe(geo.cardH + geo.gapSlice);
    expect(rowPitchFor(1, geo)).toBe(geo.cardH + geo.gapStack);
    expect(rowPitchFor(2, geo)).toBe(geo.cardH + geo.gapStack);
  });
});

describe("sheetPose", () => {
  it("is deterministic per group + sheet", () => {
    expect(sheetPose("d:2024-08-17", 0)).toEqual(sheetPose("d:2024-08-17", 0));
    expect(sheetPose("d:2024-08-17", 0)).not.toEqual(sheetPose("d:2024-08-17", 1));
  });

  it("cascades: deeper sheets peek further, in one stable direction", () => {
    for (const key of ["a", "b", "m:2024-08", "d:2024-08-17", "x"]) {
      const poses = [0, 1, 2].map((i) => sheetPose(key, i));
      for (const p of poses) {
        expect(Math.abs(p.rotate)).toBeLessThanOrEqual(5.4);
        expect(Math.abs(p.rotate)).toBeGreaterThanOrEqual(0.3);
        expect(p.offsetY).toBeGreaterThan(0);
        // Fan tilt opposes the slip direction (right side lower).
        expect(Math.sign(p.rotate)).toBe(-Math.sign(p.offsetX));
      }
      for (let i = 1; i < poses.length; i++) {
        expect(Math.abs(poses[i].offsetX)).toBeGreaterThan(
          Math.abs(poses[i - 1].offsetX),
        );
        expect(poses[i].offsetY).toBeGreaterThan(poses[i - 1].offsetY);
      }
    }
  });
});

describe("frameGeometryFor (Rev 10)", () => {
  it("sizes the card to ~70% of the field height, portrait", () => {
    const geo = frameGeometryFor(1424, 902);
    expect(geo.cardH).toBe(Math.round(902 * 0.7));
    expect(geo.cardW).toBeLessThanOrEqual(geo.cardH); // portrait
    expect(geo.cardW).toBeGreaterThan(0);
  });

  it("clamps the height between 300 and 720", () => {
    expect(frameGeometryFor(1424, 2000).cardH).toBe(720);
    expect(frameGeometryFor(1424, 300).cardH).toBe(300);
  });

  it("never lets the card overflow the field width", () => {
    const mobile = frameGeometryFor(390, 700);
    expect(mobile.cardW).toBeLessThanOrEqual(390 - 40);
    expect(mobile.cardW).toBeGreaterThanOrEqual(240);
  });

  it("derives a pitch that shows ~1.2-1.5 cards per screen", () => {
    const geo = frameGeometryFor(1424, 902);
    expect(geo.pitch).toBeGreaterThan(geo.cardH);
    expect(902 / geo.pitch).toBeGreaterThanOrEqual(1.1);
    expect(902 / geo.pitch).toBeLessThanOrEqual(2);
  });
});

describe("framePitchFor (Rev 10)", () => {
  const geo = frameGeometryFor(1424, 902);
  it("slice rows pack tighter than stack rows (the pile needs the gap)", () => {
    expect(framePitchFor(0, geo)).toBeLessThan(framePitchFor(1, geo));
    expect(framePitchFor(1, geo)).toBe(framePitchFor(2, geo));
  });
});

describe("backingSheets (Rev 10 tiers)", () => {
  it("small piles show their real count, mid piles read as five, big as seven", () => {
    expect(backingSheets(1)).toBe(0);
    expect(backingSheets(2)).toBe(1);
    expect(backingSheets(3)).toBe(2);
    expect(backingSheets(4)).toBe(4);
    expect(backingSheets(8)).toBe(4);
    expect(backingSheets(9)).toBe(6);
    expect(backingSheets(700)).toBe(6);
  });
});
