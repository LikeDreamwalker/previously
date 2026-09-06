/**
 * Serpentine region layout — pure functions (Rev 7 §R7.1). No three.js
 * imports: the scene consumes plain numbers, the module stays unit-testable.
 *
 * Model (user-dictated, 2026-09-07):
 * - A region (week / day / hour) lays its slices out in STRICT chronological
 *   order as a serpentine (boustrophedon) grid: row 1 left→right, row 2
 *   right→left (so card 5 sits directly under card 4), row 3 left→right…
 *   A partial last row on an odd (right→left) row is RIGHT-aligned.
 * - The "highway" is the traversal polyline through card centers, with
 *   U-turns at alternating row ends. Strand lines ride this highway
 *   (see strand-path.ts); the grid itself is strand-agnostic.
 * - Local coordinates: x rightward from the grid's left edge, yDown
 *   DOWNWARD from the first row's midline. The scene maps local (x, yDown)
 *   to world (originX + x, originY − yDown) — world y decreases toward now.
 */

import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

// ─── Types ─────────────────────────────────────────────────────────────────

export type RegionLevel = "week" | "day" | "hour";

export interface SerpentineGridConfig {
  /** Card size in world units. */
  cardW: number;
  cardH: number;
  /** Gaps between cards / row midlines, world units. */
  gapX: number;
  gapY: number;
  /** Cards per row (responsive, ≥1). Bounded below by "a strand line must be
   *  able to thread the card" (§R7.0) — the caller enforces the floor. */
  perRow: number;
}

export interface GridCard {
  /** Traversal index = chronological order within the region. */
  index: number;
  row: number;
  /** Visual column, 0 = leftmost. On odd rows the snake flips the mapping. */
  col: number;
  /** Center, local coords (y is yDown). */
  x: number;
  y: number;
}

export interface SerpentineGrid {
  cards: GridCard[];
  rows: number;
  /** Grid width = full row width even when the last row is partial. */
  width: number;
  /** Height from the first to the last row midline, plus one card height. */
  height: number;
  /** Midline yDown per row. */
  rowY: number[];
  /**
   * The traversal highway: polyline through every card center in traversal
   * order, with explicit U-turn midpoints between rows. Strand paths are
   * derived from this polyline. Local coords, yDown.
   */
  highway: [number, number][];
}

/** Vertical pitch between row midlines. */
export function rowPitch(cfg: SerpentineGridConfig): number {
  return cfg.cardH + cfg.gapY;
}

/** Full grid width for a config (all rows share it, partial last row too). */
export function gridWidth(cfg: SerpentineGridConfig): number {
  return cfg.perRow * cfg.cardW + (cfg.perRow - 1) * cfg.gapX;
}

// ─── Grid ──────────────────────────────────────────────────────────────────

/**
 * Lay out `count` cards serpentine-style. Row r holds cards
 * [r·perRow, (r+1)·perRow); even rows run left→right, odd rows right→left
 * (visual column = perRow−1−j). The odd-row mapping automatically
 * right-aligns a partial last row (card 5 lands under card 4).
 */
export function serpentineGrid(
  count: number,
  cfg: SerpentineGridConfig,
): SerpentineGrid {
  const perRow = Math.max(1, Math.floor(cfg.perRow));
  const pitch = rowPitch(cfg);
  const width = gridWidth(cfg);
  const rows = count === 0 ? 0 : Math.ceil(count / perRow);

  const cards: GridCard[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const j = i % perRow;
    const col = row % 2 === 0 ? j : perRow - 1 - j;
    cards.push({
      index: i,
      row,
      col,
      x: cfg.cardW / 2 + col * (cfg.cardW + cfg.gapX),
      y: row * pitch,
    });
  }

  const rowY = Array.from({ length: rows }, (_, r) => r * pitch);

  // Highway: card centers in traversal order, plus a U-turn midpoint at each
  // row boundary (half a pitch past the row end, so the turn reads as an arc
  // rather than a corner).
  const highway: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const c = cards[i];
    highway.push([c.x, c.y]);
    if (i + 1 < count && cards[i + 1].row !== c.row) {
      const dir = c.row % 2 === 0 ? 1 : -1; // even row exits right, odd left
      const endX = dir === 1 ? width + cfg.gapX / 2 : -cfg.gapX / 2;
      highway.push([endX, c.y + pitch / 2]);
    }
  }

  return {
    cards,
    rows,
    width,
    height: rows === 0 ? 0 : (rows - 1) * pitch + cfg.cardH,
    rowY,
    highway,
  };
}

// ─── Region partitioning (week / day / hour) ───────────────────────────────

export interface RegionSliceGroup {
  /** Stable key: "2026-W34" / "2026-08-17" / "2026-08-17T14". */
  key: string;
  /** Display label (mono, e.g. "08-17 – 08-23" / "08-17" / "08-17 14:00"). */
  label: string;
  /** Region start (ms epoch) — the boundary tick on the spine. */
  startMs: number;
  /** Slices in chronological order. */
  entries: TimelineSliceEntry[];
}

/** ISO 8601 week (Monday start), in LOCAL time. Returns [isoYear, isoWeek]. */
export function isoWeek(date: Date): [number, number] {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay() || 7; // Sunday → 7
  d.setDate(d.getDate() + 4 - day); // nearest Thursday
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return [d.getFullYear(), week];
}

function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  return d;
}

const pad = (n: number) => String(n).padStart(2, "0");
const md = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function groupKey(
  e: TimelineSliceEntry,
  level: RegionLevel,
): { key: string; label: string; startMs: number } {
  // LOCAL time throughout: the catalog's `date` is derived from the slice id,
  // which is local-time; grouping must agree with what the cards display.
  const d = new Date(e.start);
  if (level === "day") {
    return {
      key: e.date,
      label: e.date.slice(5).replace("-", "/"),
      startMs: Date.parse(e.date + "T00:00:00"),
    };
  }
  if (level === "hour") {
    const hour = `${e.date}T${pad(d.getHours())}`;
    return {
      key: hour,
      label: `${md(d)} ${pad(d.getHours())}:00`,
      startMs: Date.parse(hour + ":00:00"),
    };
  }
  // week
  const mon = mondayOf(d);
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  const [isoY, isoW] = isoWeek(d);
  return {
    key: `${isoY}-W${pad(isoW)}`,
    label: `${md(mon)} – ${md(sun)}`,
    startMs: mon.getTime(),
  };
}

/**
 * Partition a chronologically sorted catalog into region groups. Empty
 * periods produce no region (no slices → nothing to show); time gaps are
 * expressed on the spine, not by empty regions.
 */
export function partitionRegions(
  entries: TimelineSliceEntry[],
  level: RegionLevel,
): RegionSliceGroup[] {
  const groups: RegionSliceGroup[] = [];
  let cur: RegionSliceGroup | null = null;
  for (const e of entries) {
    const g = groupKey(e, level);
    if (cur && cur.key === g.key) {
      cur.entries.push(e);
    } else {
      cur = { key: g.key, label: g.label, startMs: g.startMs, entries: [e] };
      groups.push(cur);
    }
  }
  return groups;
}
