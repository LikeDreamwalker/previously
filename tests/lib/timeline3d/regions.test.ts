import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { NOW_GAP } from "@/lib/timeline3d/layout";
import {
  computeRegionScene,
  findSlicePosition,
  nearestSliceAtY,
  cardWorldPosition,
  regionBottom,
  perRowForWidth,
  levelConfigFor,
  regionZoomState,
  FOV_DEG,
  GRID_X,
  LEVEL_CONFIG,
  MAX_ZOOM_LEVEL,
  ZOOM_REGIONS,
  type RegionLevelConfig,
} from "@/lib/timeline3d/regions";

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

describe("computeRegionScene — region stacking", () => {
  it("stacks regions top-down, oldest first, y strictly decreasing", () => {
    const scene = computeRegionScene(
      [
        entry("2026-08-10T10:00:00.000Z"), // week of 08-10
        entry("2026-08-11T09:00:00.000Z"), // same week
        entry("2026-08-19T20:00:00.000Z"), // week of 08-17
      ],
      "week",
      4,
    );
    expect(scene.regions).toHaveLength(2);
    expect(scene.regions[0].key).toBe("2026-W33");
    expect(scene.regions[1].key).toBe("2026-W34");
    expect(scene.regions[0].originY).toBe(0);
    // Second region hangs (grid height + regionGap) below the first.
    const cfg = LEVEL_CONFIG.week;
    expect(scene.regions[1].originY).toBeCloseTo(
      -(scene.regions[0].grid.height + cfg.regionGap),
      10,
    );
    expect(scene.regions[1].originY).toBeLessThan(scene.regions[0].originY);
  });

  it("grids sit at GRID_X and map local (x, yDown) → world (originX+x, originY−yDown)", () => {
    const scene = computeRegionScene(
      [entry("2026-08-17T01:00:00.000Z"), entry("2026-08-17T02:00:00.000Z")],
      "day",
      2,
    );
    const region = scene.regions[0];
    expect(region.originX).toBe(GRID_X);
    expect(region.entries).toHaveLength(2);
    for (let i = 0; i < region.entries.length; i++) {
      const [wx, wy] = cardWorldPosition(region, i);
      const card = region.grid.cards[i];
      expect(wx).toBeCloseTo(GRID_X + card.x, 10);
      expect(wy).toBeCloseTo(region.originY - card.y, 10);
    }
  });

  it("NOW rests NOW_GAP below the newest region's bottom edge; yTop is the oldest region's top edge", () => {
    const scene = computeRegionScene(
      [entry("2026-08-17T01:00:00.000Z"), entry("2026-08-18T02:00:00.000Z")],
      "day",
      3,
    );
    const cfg = LEVEL_CONFIG.day;
    expect(scene.yTop).toBeCloseTo(scene.regions[0].originY + cfg.cardH / 2, 10);
    const last = scene.regions[scene.regions.length - 1];
    expect(scene.nowY).toBeCloseTo(regionBottom(last) - NOW_GAP, 10);
    expect(scene.nowPosition[1]).toBe(scene.nowY);
    expect(scene.nowY).toBeLessThan(last.originY);
  });

  it("returns an empty scene for an empty catalog", () => {
    const scene = computeRegionScene([], "week", 4);
    expect(scene.regions).toEqual([]);
    expect(scene.yTop).toBe(0);
    expect(scene.nowY).toBe(-NOW_GAP);
  });

  it("sorts defensively when the catalog is out of order", () => {
    const scene = computeRegionScene(
      [entry("2026-08-18T10:00:00.000Z"), entry("2026-08-17T10:00:00.000Z")],
      "day",
      3,
    );
    expect(scene.regions[0].label).toBe("08/17");
    expect(scene.regions[1].label).toBe("08/18");
  });

  it("perRow controls the serpentine row count", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      entry(`2026-08-17T0${i}:00:00.000Z`),
    );
    const wide = computeRegionScene(entries, "day", 3);
    expect(wide.regions[0].grid.rows).toBe(3); // 3+3+1
    const narrow = computeRegionScene(entries, "day", 7);
    expect(narrow.regions[0].grid.rows).toBe(1);
  });
});

describe("findSlicePosition", () => {
  it("locates a slice's card center across regions", () => {
    const a = entry("2026-08-17T01:00:00.000Z");
    const b = entry("2026-08-18T02:00:00.000Z");
    const scene = computeRegionScene([a, b], "hour", 1);
    const pos = findSlicePosition(scene, b.id);
    expect(pos).not.toBeNull();
    const region = scene.regions[1];
    expect(pos![0]).toBeCloseTo(GRID_X + region.grid.cards[0].x, 10);
    expect(pos![1]).toBeCloseTo(region.originY, 10);
    expect(findSlicePosition(scene, "nope")).toBeNull();
  });
});

describe("nearestSliceAtY — the zoom re-anchor", () => {
  it("returns the slice whose card center is nearest the y", () => {
    const scene = computeRegionScene(
      [
        entry("2026-08-10T10:00:00.000Z"),
        entry("2026-08-11T09:00:00.000Z"),
        entry("2026-08-19T20:00:00.000Z"),
      ],
      "day",
      3,
    );
    const [, y1] = cardWorldPosition(scene.regions[0], 0);
    const [, y2] = cardWorldPosition(scene.regions[1], 0);
    expect(nearestSliceAtY(scene, y1 - 0.01)!.id).toBe(scene.regions[0].entries[0].id);
    expect(nearestSliceAtY(scene, y2 + 0.01)!.id).toBe(scene.regions[1].entries[0].id);
    // Way below everything still anchors to the newest slice.
    const last = scene.regions[scene.regions.length - 1];
    expect(nearestSliceAtY(scene, -999)!.id).toBe(last.entries[0].id);
  });

  it("returns null on an empty scene", () => {
    expect(nearestSliceAtY(computeRegionScene([], "day", 3), 0)).toBeNull();
  });
});

describe("levelConfigFor — pixel anchoring", () => {
  const tanHalfFov = Math.tan(((FOV_DEG / 2) * Math.PI) / 180);

  it("week/day card slots occupy exactly their spec pixels on screen", () => {
    // A slot's world size ÷ visible world height × canvas height = spec px.
    for (const [level, cardPx, gapPx] of [
      ["week", 144, 14],
      ["day", 224, 20],
    ] as const) {
      const canvasH = 800;
      const cfg = levelConfigFor(level, canvasH);
      const visWorldH = 2 * tanHalfFov * cfg.distance;
      expect((cfg.cardW / visWorldH) * canvasH).toBeCloseTo(cardPx, 6);
      expect((cfg.gapX / visWorldH) * canvasH).toBeCloseTo(gapPx, 6);
      // Taller canvas → more px per world unit → smaller world-unit slots.
      const cfg2 = levelConfigFor(level, canvasH * 2);
      expect(cfg2.cardW).toBeCloseTo(cfg.cardW / 2, 6);
    }
  });

  it("hour keeps its static world-unit config", () => {
    expect(levelConfigFor("hour", 800)).toBe(LEVEL_CONFIG.hour);
  });
});

describe("perRowForWidth", () => {
  it("clamps to [1, maxPerRow]", () => {
    expect(perRowForWidth(320, 568, "week")).toBe(1);
    expect(perRowForWidth(4096, 800, "week")).toBe(14);
    expect(perRowForWidth(4096, 800, "day")).toBe(8);
    expect(perRowForWidth(4096, 800, "hour")).toBe(1);
  });

  it("grows with canvas width (world-space grid fill right of the spine)", () => {
    // 1280×800, week: visWorldW = 2·tan13°·46·1.6 ≈ 33.98; right of the 18%
    // spine and reserves → 24.87; card pitch = (144+14)px ≈ 4.19 → 6.
    expect(perRowForWidth(1280, 800, "week")).toBe(6);
    // Narrow phone, day: one 224px card already exceeds the field → 1.
    expect(perRowForWidth(390, 700, "day")).toBe(1);
    // Wider canvas at the same height fits strictly more columns.
    expect(perRowForWidth(1920, 1080, "week")).toBeGreaterThan(
      perRowForWidth(1280, 800, "week"),
    );
  });
});

describe("computeRegionScene — cfg override", () => {
  it("defaults to the static LEVEL_CONFIG and passes an override through", () => {
    const es = [entry("2026-08-17T01:00:00.000Z")];
    expect(computeRegionScene(es, "day", 3).cfg).toBe(LEVEL_CONFIG.day);
    const custom: RegionLevelConfig = {
      ...LEVEL_CONFIG.day,
      cardW: 5,
      regionGap: 9,
    };
    const scene = computeRegionScene(es, "day", 3, custom);
    expect(scene.cfg).toBe(custom);
    // The override actually drives the layout (region gap between regions).
    const two = computeRegionScene(
      [entry("2026-08-17T01:00:00.000Z"), entry("2026-08-18T01:00:00.000Z")],
      "day",
      3,
      custom,
    );
    expect(two.regions[1].originY).toBeCloseTo(
      -(two.regions[0].grid.height + custom.regionGap),
      10,
    );
  });
});

describe("regionZoomState", () => {
  it("maps levels 0|1|2 to week|day|hour with the level's fixed distance", () => {
    expect(ZOOM_REGIONS[0]).toBe("week");
    expect(ZOOM_REGIONS[1]).toBe("day");
    expect(ZOOM_REGIONS[2]).toBe("hour");
    expect(MAX_ZOOM_LEVEL).toBe(2);
    for (const l of [0, 1, 2] as const) {
      const zs = regionZoomState(l);
      expect(zs.region).toBe(ZOOM_REGIONS[l]);
      expect(zs.distance).toBe(LEVEL_CONFIG[zs.region].distance);
    }
    // Distances shrink monotonically from far (week) to near (hour).
    expect(LEVEL_CONFIG.day.distance).toBeLessThan(LEVEL_CONFIG.week.distance);
    expect(LEVEL_CONFIG.hour.distance).toBeLessThan(LEVEL_CONFIG.day.distance);
  });
});
