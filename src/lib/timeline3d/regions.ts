/**
 * Region scene layout — pure functions (Rev 7 §R7.0–§R7.1). No three.js
 * imports: the scene consumes plain numbers, the module stays unit-testable.
 *
 * Rev 7 replaces the L0–L4 abstraction tiers with three CALENDAR-GRAIN
 * levels — week (远眺, the shape of time) / day (俯瞰, the day's threads) /
 * hour (凝视, one conversation) — each laying its slices out as strict
 * chronological serpentine grids stacked in regions (serpentine.ts), oldest
 * region on top, world y decreasing toward NOW. The spine stays a straight
 * vertical at x = coreXAt(y); region grids hang to its RIGHT at GRID_X.
 *
 * Local → world mapping per region: grid local (x, yDown) maps to world
 * (originX + x, originY − yDown), where originY is the region's first-row
 * midline.
 */

import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { coreXAt, NOW_GAP } from "./layout";
import {
  partitionRegions,
  serpentineGrid,
  type RegionLevel,
  type SerpentineGrid,
} from "./serpentine";

export type { RegionLevel } from "./serpentine";

// ─── Zoom levels (Rev 7: three levels, level = a calendar grain) ───────────

/** Discrete zoom levels: 0 = week (远眺) · 1 = day (俯瞰) · 2 = hour (凝视). */
export type ZoomLevel = 0 | 1 | 2;
export const MAX_ZOOM_LEVEL: ZoomLevel = 2;

/** Zoom level → region grain. */
export const ZOOM_REGIONS: Record<ZoomLevel, RegionLevel> = {
  0: "week",
  1: "day",
  2: "hour",
};

// ─── Per-level configuration ───────────────────────────────────────────────

export interface RegionLevelConfig {
  /** Fixed camera distance for the level (the rig eases toward it). */
  distance: number;
  /** Card size in world units. */
  cardW: number;
  cardH: number;
  /** Gaps between cards / row midlines, world units. */
  gapX: number;
  gapY: number;
  /** Vertical gap between stacked regions, world units. */
  regionGap: number;
  /** Upper bound for the responsive cards-per-row (§R7.2: the grid fills the
   *  right field — a dense ten-across layout is a legal shape). */
  maxPerRow: number;
}

/**
 * Initial tuning values (§R7.0: sizes are iterated against screenshots).
 * The hour level is the degenerate one-card-per-row case (maxPerRow 1).
 * Week/day world sizes are DERIVED from the pixel spec below via
 * levelConfigFor (cards are fixed-CSS-px DOM — the world slot must match the
 * pixels at the level's camera distance); these static values remain as the
 * test/default fallback.
 */
export const LEVEL_CONFIG: Record<RegionLevel, RegionLevelConfig> = {
  week: {
    distance: 46,
    cardW: 2.6,
    cardH: 1.7,
    gapX: 0.5,
    gapY: 0.5,
    regionGap: 2.5,
    maxPerRow: 6,
  },
  day: {
    distance: 30,
    cardW: 3.6,
    cardH: 2.2,
    gapX: 0.7,
    gapY: 0.6,
    regionGap: 2.0,
    maxPerRow: 3,
  },
  hour: {
    distance: 15,
    cardW: 7.5,
    cardH: 5.2,
    gapX: 0,
    gapY: 1.2,
    regionGap: 1.5,
    maxPerRow: 1,
  },
};

/** World x of every region grid's LEFT edge — right of the spine. */
export const GRID_X = 2.2;

/** Camera field of view (degrees) — the single source for the canvas camera
 *  and every px↔world conversion (scene-canvas imports it from here). */
export const FOV_DEG = 26;

/**
 * Pixel-anchored card spec (§R7.2 网格铺满): the DOM cards are fixed CSS px,
 * so the grid's world-unit slots are the pixel sizes divided by the level's
 * pxPerUnit at its camera distance. Hour stays in hand-tuned world units —
 * the stage card slot is deliberately roomy.
 */
const PIXEL_SPEC = {
  // Week cards are two-liners (mono time eyebrow + title) — user 2026-09-07:
  // a better aspect ratio than the thin strip, and taller rows give the
  // strand channels room to thread.
  week: { cardWPx: 144, cardHPx: 52, gapXPx: 14, gapYPx: 12, regionGapPx: 44, maxPerRow: 14 },
  day: { cardWPx: 224, cardHPx: 100, gapXPx: 20, gapYPx: 18, regionGapPx: 36, maxPerRow: 8 },
} as const;

/**
 * Level config anchored to the canvas height: pxPerUnit = canvasHPx /
 * visible world height at the level's camera distance. Week/day sizes are
 * pixel-derived; hour returns its static world config unchanged.
 */
export function levelConfigFor(
  level: RegionLevel,
  canvasHPx: number,
): RegionLevelConfig {
  const base = LEVEL_CONFIG[level];
  if (level === "hour") return base;
  const spec = PIXEL_SPEC[level];
  const pxPerUnit =
    canvasHPx /
    (2 * Math.tan(((FOV_DEG / 2) * Math.PI) / 180) * base.distance);
  return {
    distance: base.distance,
    cardW: spec.cardWPx / pxPerUnit,
    cardH: spec.cardHPx / pxPerUnit,
    gapX: spec.gapXPx / pxPerUnit,
    gapY: spec.gapYPx / pxPerUnit,
    regionGap: spec.regionGapPx / pxPerUnit,
    maxPerRow: spec.maxPerRow,
  };
}

/** Level → camera state. Pure: the gesture rig owns the level, everything
 *  visual derives from this (the Rev 5 zoomStateForLevel discipline, shrunk
 *  to three levels; the strandArcs/cardTier fields are gone — §R7.6). */
export interface RegionZoomState {
  level: ZoomLevel;
  region: RegionLevel;
  /** The level's fixed camera distance from the spine plane. */
  distance: number;
}

export function regionZoomState(level: ZoomLevel): RegionZoomState {
  const region = ZOOM_REGIONS[level];
  return { level, region, distance: LEVEL_CONFIG[region].distance };
}

// ─── Responsive cards-per-row ──────────────────────────────────────────────

/**
 * Cards per row from the canvas size, in WORLD units (§R7.2 网格铺满): the
 * visible world width right of the spine (the Rev 6 camera frame puts the
 * spine at ≈18% desktop / ≈10% phone of screen x) minus the GRID_X offset
 * and a small breathing reserve, divided by the pixel-anchored card pitch.
 * Clamped to [1, maxPerRow] — a narrow phone degrades to a single column.
 */
export function perRowForWidth(
  canvasWPx: number,
  canvasHPx: number,
  level: RegionLevel,
): number {
  const cfg = levelConfigFor(level, canvasHPx);
  const visWorldW =
    2 *
    Math.tan(((FOV_DEG / 2) * Math.PI) / 180) *
    cfg.distance *
    (canvasWPx / canvasHPx);
  const spineFrac = canvasWPx < 768 ? 0.1 : 0.18;
  const maxGridW = visWorldW * (1 - spineFrac) - GRID_X - 0.8;
  const perRow = Math.floor((maxGridW + cfg.gapX) / (cfg.cardW + cfg.gapX));
  return Math.min(Math.max(perRow, 1), cfg.maxPerRow);
}

// ─── Region scene ──────────────────────────────────────────────────────────

export interface RegionLayout {
  /** The grain this region partitions by (week / day / hour). */
  level: RegionLevel;
  /** Stable key from partitionRegions ("2026-W34" / "2026-08-17" / …). */
  key: string;
  /** Mono display label ("08-17 – 08-23" / "08-17" / "08-17 14:00"). */
  label: string;
  /** Region start (ms epoch). */
  startMs: number;
  /** Slices in chronological order — grid.cards[i] is entries[i]'s seat. */
  entries: TimelineSliceEntry[];
  grid: SerpentineGrid;
  /** World x of the grid's left edge (GRID_X). */
  originX: number;
  /** World y of the first row's midline (regions stack top-down from 0). */
  originY: number;
}

export interface RegionScene {
  level: RegionLevel;
  /** Oldest → newest, top → bottom. */
  regions: RegionLayout[];
  /** The config the scene was laid out with (pixel-anchored at runtime,
   *  LEVEL_CONFIG static in tests) — probes and strand geometry read this. */
  cfg: RegionLevelConfig;
  /** Top edge of the first (oldest) region — the spine's top. */
  yTop: number;
  /** Y of the NOW convergence point, NOW_GAP below the newest region. */
  nowY: number;
  nowPosition: [number, number, number];
}

/** World position of a grid card's center within its region. */
export function cardWorldPosition(
  region: RegionLayout,
  cardIndex: number,
): [number, number] {
  const card = region.grid.cards[cardIndex];
  return [region.originX + card.x, region.originY - card.y];
}

/** World position of a slice's card center in the scene, or null. */
export function findSlicePosition(
  scene: RegionScene,
  sliceId: string,
): [number, number] | null {
  for (const region of scene.regions) {
    const i = region.entries.findIndex((e) => e.id === sliceId);
    if (i >= 0) return cardWorldPosition(region, i);
  }
  return null;
}

/** The slice whose card center is nearest a world y — the zoom re-anchor:
 *  a level switch re-lays the scene out at a different scale, so the camera
 *  re-centers on the same slice in the target level instead of keeping a
 *  world y that now maps to a different time. */
export function nearestSliceAtY(
  scene: RegionScene,
  y: number,
): { id: string; y: number } | null {
  let best: { id: string; y: number } | null = null;
  for (const region of scene.regions) {
    for (let i = 0; i < region.entries.length; i++) {
      const cy = cardWorldPosition(region, i)[1];
      if (!best || Math.abs(cy - y) < Math.abs(best.y - y)) {
        best = { id: region.entries[i].id, y: cy };
      }
    }
  }
  return best;
}

/** World y of a region's bottom edge (last row's lower card edge). */
export function regionBottom(
  region: RegionLayout,
  cfg: RegionLevelConfig = LEVEL_CONFIG[region.level],
): number {
  return region.originY - region.grid.height + cfg.cardH / 2;
}

/**
 * Compute the region scene for one level. Entries are sorted by start
 * defensively (the catalog is already oldest → newest). Regions partition by
 * the level's calendar grain and stack top-down: the oldest region's
 * first-row midline sits at y = 0, each newer region hangs
 * (prevHeight + regionGap) lower. NOW rests NOW_GAP below the newest
 * region's bottom edge. An empty catalog yields no regions with NOW at
 * −NOW_GAP, matching computeTimelineLayout's empty shape.
 */
export function computeRegionScene(
  entries: TimelineSliceEntry[],
  level: RegionLevel,
  perRow: number,
  cfg: RegionLevelConfig = LEVEL_CONFIG[level],
): RegionScene {
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start));
  const groups = partitionRegions(sorted, level);

  const regions: RegionLayout[] = [];
  let originY = 0;
  for (const g of groups) {
    const grid = serpentineGrid(g.entries.length, {
      cardW: cfg.cardW,
      cardH: cfg.cardH,
      gapX: cfg.gapX,
      gapY: cfg.gapY,
      perRow,
    });
    regions.push({
      level,
      key: g.key,
      label: g.label,
      startMs: g.startMs,
      entries: g.entries,
      grid,
      originX: GRID_X,
      originY,
    });
    originY -= grid.height + cfg.regionGap;
  }

  const yTop = regions.length > 0 ? regions[0].originY + cfg.cardH / 2 : 0;
  const bottom =
    regions.length > 0 ? regionBottom(regions[regions.length - 1], cfg) : 0;
  const nowY = bottom - NOW_GAP;
  return {
    level,
    regions,
    cfg,
    yTop,
    nowY,
    nowPosition: [coreXAt(nowY), nowY, 0],
  };
}
