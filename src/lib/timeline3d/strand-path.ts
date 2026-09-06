/**
 * Strand serpentine-traversal paths — pure functions (Rev 7 §R7.2, Manhattan
 * revision 2026-09-07, user-dictated geometry discipline):
 *
 * - Paths are MANHATTAN only: horizontal segments, vertical segments, and
 *   small 90° quarter-arc fillets (filletManhattan). No free curves, no big
 *   loops.
 * - Horizontal segments sit exactly on a ROW MIDLINE (through related cards —
 *   the DOM cards render above the WebGL canvas, so a straight line along the
 *   midline is occluded by the cards it threads) or on an INTER-ROW GAP
 *   midline (bypassing unrelated cards: even rows arc through the gap above,
 *   odd rows through the gap below — the gap side alternates with the snake).
 * - Left of the grid there are no per-strand lanes: every strand's vertical
 *   segments share ONE bundle x (collinear, pixel-aligned). The per-strand
 *   parallel offset is applied by the scene layer, not here.
 * - After the LAST related card the strand keeps riding the gap lanes until
 *   the left end of a right→left row, drops a short segment, and returns
 *   straight left to the bundle ("提前结束就提前回去"); a strand related to
 *   the region's very last card uses the region-end gate instead.
 *
 * Region-local coordinates (yDown positive downward), same convention as
 * serpentine.ts. Points are pure 2D — z is always 0 in this revision.
 */

import type { SerpentineGrid } from "./serpentine";

export type StrandPointKind =
  | "enter" // approach from the bundle to the highway start
  | "through" // card center on the row midline
  | "bypass" // inter-row gap midline around an unrelated card
  | "uturn" // row-end turn at the row's travel end
  | "exit" // early return: down a segment, then straight left to the bundle
  | "gate"; // region end: down a segment below the last card, then left

export interface StrandPathPoint {
  x: number;
  /** yDown — region-local, positive downward. */
  y: number;
  kind: StrandPointKind;
}

/** Gate: how far below the last card's row midline the strand drops. */
export const GATE_DOWN_RATIO = 0.9; // × cardH
/** Early exit: how far below the exit row's midline the strand drops. */
export const EXIT_DOWN_RATIO = 0.75; // × cardH

// ─── Manhattan fillet ──────────────────────────────────────────────────────

/**
 * Round the corners of a Manhattan polyline (adjacent points differ on one
 * axis only). Consecutive duplicates are dropped, collinear monotonic runs
 * are merged to their endpoints, and every remaining corner is replaced by a
 * quarter-arc of 8 segments with radius min(radius, half the shorter adjacent
 * segment). First and last points are never moved. Non-orthogonal corners
 * (should not occur) pass through sharp.
 */
export function filletManhattan(
  pts: [number, number][],
  radius: number,
): [number, number][] {
  const clean: [number, number][] = [];
  for (const p of pts) {
    const l = clean[clean.length - 1];
    if (!l || Math.abs(l[0] - p[0]) > 1e-9 || Math.abs(l[1] - p[1]) > 1e-9) {
      clean.push([p[0], p[1]]);
    }
  }
  if (clean.length <= 2) return clean;

  // Merge collinear runs: drop b when it lies between a and c on a shared
  // axis (a reversal kink is a real corner and survives).
  const merged: [number, number][] = [clean[0]];
  for (let i = 1; i < clean.length - 1; i++) {
    const a = merged[merged.length - 1];
    const b = clean[i];
    const c = clean[i + 1];
    let axis: 0 | 1 | -1 = -1;
    if (a[0] === b[0] && b[0] === c[0]) axis = 1;
    else if (a[1] === b[1] && b[1] === c[1]) axis = 0;
    if (axis >= 0) {
      const av = axis === 0 ? a[0] : a[1];
      const bv = axis === 0 ? b[0] : b[1];
      const cv = axis === 0 ? c[0] : c[1];
      const lo = Math.min(av, cv);
      const hi = Math.max(av, cv);
      if (bv >= lo - 1e-9 && bv <= hi + 1e-9) continue;
    }
    merged.push(b);
  }
  merged.push(clean[clean.length - 1]);
  if (merged.length <= 2) return merged;

  const out: [number, number][] = [merged[0]];
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1];
    const p = merged[i];
    const b = merged[i + 1];
    const d1x = p[0] - a[0];
    const d1y = p[1] - a[1];
    const d2x = b[0] - p[0];
    const d2y = b[1] - p[1];
    const l1 = Math.hypot(d1x, d1y);
    const l2 = Math.hypot(d2x, d2y);
    const axis1 = Math.abs(d1x) > 1e-9 ? 0 : 1;
    const axis2 = Math.abs(d2x) > 1e-9 ? 0 : 1;
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (axis1 === axis2 || r < 1e-9) {
      out.push(p);
      continue;
    }
    const u1x = d1x / l1;
    const u1y = d1y / l1;
    const u2x = d2x / l2;
    const u2y = d2y / l2;
    const p1x = p[0] - u1x * r;
    const p1y = p[1] - u1y * r;
    const p2x = p[0] + u2x * r;
    const p2y = p[1] + u2y * r;
    const cx = p1x + u2x * r;
    const cy = p1y + u2y * r;
    const a0 = Math.atan2(p1y - cy, p1x - cx);
    const a1 = Math.atan2(p2y - cy, p2x - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 0; k <= 8; k++) {
      const t = a0 + (da * k) / 8;
      out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  out.push(merged[merged.length - 1]);
  return out;
}

// ─── Region path ───────────────────────────────────────────────────────────

export interface StrandRegionPathConfig {
  cardW: number;
  cardH: number;
  gapX: number;
  gapY: number;
  perRow: number;
  /** Local x of the shared bundle vertical (= BUNDLE_X − region.originX). */
  bundleX: number;
}

/**
 * Compute one strand's Manhattan waypoint path through one region. `carriers`
 * holds the traversal indices (within this region) of slices carrying the
 * strand. Returns null when the strand has no carrier in this region.
 */
export function strandRegionPath(
  grid: SerpentineGrid,
  carriers: ReadonlySet<number>,
  cfg: StrandRegionPathConfig,
): StrandPathPoint[] | null {
  const { cards } = grid;
  if (cards.length === 0) return null;
  let first = -1;
  let last = -1;
  for (const c of cards) {
    if (carriers.has(c.index)) {
      if (first === -1) first = c.index;
      last = c.index;
    }
  }
  if (first === -1) return null;

  const pitch = cfg.cardH + cfg.gapY;
  const midY = (r: number) => r * pitch;
  const gapYOf = (r: number) =>
    midY(r) +
    (r % 2 === 0
      ? -(cfg.cardH / 2 + cfg.gapY / 2) // even rows (L→R) arc above
      : cfg.cardH / 2 + cfg.gapY / 2); // odd rows (R→L) arc below
  const endXR = grid.width + cfg.gapX / 2;
  const endXL = -cfg.gapX / 2;
  const lastIndex = cards.length - 1;
  const laneFor = (i: number) =>
    carriers.has(i) ? midY(cards[i].row) : gapYOf(cards[i].row);
  /** Approach-side boundary x of card i: half a card + half a gap before the
   *  center in the row's travel direction (the midpoint between adjacent
   *  same-row cards; the row-end margin x for a row's first card). */
  const boundaryX = (i: number) =>
    cards[i].x +
    (cards[i].row % 2 === 0 ? -1 : 1) * (cfg.cardW / 2 + cfg.gapX / 2);

  const points: StrandPathPoint[] = [];
  const push = (x: number, y: number, kind: StrandPointKind) => {
    const l = points[points.length - 1];
    if (l && Math.abs(l.x - x) < 1e-9 && Math.abs(l.y - y) < 1e-9) return;
    points.push({ x, y, kind });
  };

  // 1. Enter: from the bundle to the highway start on row 0's lane.
  const lane0 = laneFor(0);
  push(cfg.bundleX, lane0, "enter");
  push(endXL, lane0, "enter");
  let lane = lane0;

  /** Ride to card i, folding between the gap lane and the row midline at the
   *  card's approach-side boundary when the lane changes. Fold waypoints take
   *  the kind of the lane they sit on (midline → through, gap → bypass). */
  const rideTo = (i: number, forceBypass: boolean) => {
    const c = cards[i];
    const related = carriers.has(i) && !forceBypass;
    const target = related ? midY(c.row) : gapYOf(c.row);
    if (Math.abs(target - lane) > 1e-9) {
      const bx = boundaryX(i);
      push(bx, lane, Math.abs(lane - midY(c.row)) < 1e-9 ? "through" : "bypass");
      push(bx, target, related ? "through" : "bypass");
      lane = target;
    }
    push(c.x, lane, related ? "through" : "bypass");
  };

  /** Row-end turn: vertical at the row's travel end from the current lane to
   *  the next row's starting lane. */
  const uturn = (i: number, nextLane: number) => {
    const endX = cards[i].row % 2 === 0 ? endXR : endXL;
    push(endX, lane, "uturn");
    push(endX, nextLane, "uturn");
    lane = nextLane;
  };

  // 2. Ride 0..last (through related, bypass unrelated; turns mid→mid).
  for (let i = 0; i <= last; i++) {
    rideTo(i, false);
    if (i < last && cards[i + 1].row !== cards[i].row) {
      uturn(i, midY(cards[i].row + 1));
    }
  }

  // 3. Region-end gate: the last related card IS the region's last card.
  if (last === lastIndex) {
    const c = cards[last];
    const yGate = midY(c.row) + cfg.cardH * GATE_DOWN_RATIO;
    push(c.x, yGate, "gate");
    push(cfg.bundleX, yGate, "gate");
    return points;
  }

  // 4. Early return: keep riding the gap lanes until the left end of an R→L
  //    row, drop a short segment, and run straight left to the bundle. If the
  //    region's last card comes first (no odd row left), fall through the
  //    gate instead.
  let i = last + 1;
  for (;;) {
    rideTo(i, true);
    const c = cards[i];
    const isRowLast = i === lastIndex || cards[i + 1].row !== c.row;
    if (isRowLast && c.row % 2 === 1) {
      push(endXL, lane, "exit");
      const exitY = midY(c.row) + cfg.cardH * EXIT_DOWN_RATIO;
      push(endXL, exitY, "exit");
      push(cfg.bundleX, exitY, "exit");
      return points;
    }
    if (i === lastIndex) {
      const yGate = midY(c.row) + cfg.cardH * GATE_DOWN_RATIO;
      push(c.x, yGate, "gate");
      push(cfg.bundleX, yGate, "gate");
      return points;
    }
    if (isRowLast) uturn(i, gapYOf(c.row + 1));
    i++;
  }
}
