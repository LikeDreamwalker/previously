/**
 * Strand scene geometry — pure functions (Rev 7 §R7.2, Manhattan revision
 * 2026-09-07). No three.js imports: the scene consumes plain numbers, the
 * module stays unit-testable.
 *
 * Given a RegionScene and a visible y-window, compute everything the
 * StrandLayer draws:
 * - Per-strand Manhattan polylines: the strand shares ONE bundle vertical at
 *   BUNDLE_X (left of the spine, collinear across strands — the semi-
 *   transparent tinted band underneath renders the "how many strands are
 *   alive" density), departs horizontally into each window region where it
 *   has carriers (strandRegionPath: through related cards on row midlines,
 *   around unrelated ones on gap midlines), returns to the bundle early or
 *   via the region-end gate, and — when alive in the newest region — drops
 *   down the bundle and turns into the NOW point with one rounded corner.
 * - Parallel offsets: each strand carries ONE fixed small y offset δ (hash-
 *   stable ordering) applied to its whole journey, so fibers run parallel and
 *   never converge or merge. The old leg-aggregation bundle lines are gone.
 * - Fade tips: vertical extensions past the window end in a two-segment fade
 *   (opacity 0.22 → 0.09), each segment its own StrandLine.
 * - Flow-dot tracks: each strand's full filleted polyline (sans fade tips)
 *   with cumulative arclength, so the renderer can drift bright dots along it.
 *
 * Geometry is rebuilt at the window-probe cadence only (§R7.4); a signature
 * lets the caller skip redundant rebuilds while the window is unchanged.
 */

import { hashString, oklchToHex, strandColor } from "./layout";
import { regionBottom, type RegionScene } from "./regions";
import { filletManhattan, strandRegionPath } from "./strand-path";

// ─── Tuning constants ──────────────────────────────────────────────────────

/** World x of the shared bundle vertical (left of the spine at x = 0). */
export const BUNDLE_X = -0.9;
/** Base line width (Line2 px) / opacity (§R7.2: 细线，不跟卡片抢戏). */
export const STRAND_LINE_WIDTH = 1.0;
export const STRAND_OPACITY = 0.5;
/** Vertical overscan past the window edges so fibers don't pop at the seam. */
const BUNDLE_OVERSCAN = 1.5;
/** Fade tip: the last 1.2 of an extension/stub splits into two 0.6 segments. */
const FADE_LEN = 1.2;
const FADE_SEG = 0.6;
const FADE_OPACITY_1 = 0.22;
const FADE_OPACITY_2 = 0.09;
/** NOW convergence: the single corner turning into the spine (clamped per
 *  corner by filletManhattan, so a large value stays safe on short tails). */
const NOW_CORNER_RADIUS = 1.2;
/** Story-over stub: how far below the last journey point the strand drops. */
const STUB_LEN = 1.2;

export type Vec3 = [number, number, number];

export interface StrandLine {
  key: string;
  /** `#rrggbb` (Line2 materials can't parse oklch strings). */
  color: string;
  width: number;
  opacity: number;
  points: Vec3[];
}

/** One strand's full filleted polyline + arclength table (flow dots). */
export interface StrandTrack {
  name: string;
  /** Strand color brightened toward white — the dot tint. */
  color: string;
  /** x,y,z triplets. */
  pts: Float32Array;
  /** Cumulative arclength per point (cum[0] = 0). */
  cum: Float32Array;
  total: number;
}

export interface StrandSceneGeometry {
  lines: StrandLine[];
  tracks: StrandTrack[];
  /** Vertical span of the tinted bundle band (window + overscan). */
  band: { yLo: number; yHi: number };
  /** Change key for the probe: rebuilds skip when the window is unchanged. */
  signature: string;
}

export const EMPTY_STRAND_GEOMETRY: StrandSceneGeometry = {
  lines: [],
  tracks: [],
  band: { yLo: 0, yHi: 0 },
  signature: "empty",
};

// ─── Strand ordering & parallel offset (deterministic, hash-stable) ────────

/** Stable strand ordering: sorted by name hash (not insertion order). */
export function orderStrands(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => hashString(a) - hashString(b));
}

/**
 * Per-strand parallel offset δ (added to yDown, so a positive δ shifts the
 * world line DOWN): one fixed value per strand for its whole journey, so the
 * fibers stay horizontal-parallel and never cross or merge (§R7.2 几何纪律).
 */
export function strandOffsetFor(idx: number): number {
  return ((idx % 10) - 4.5) * 0.042;
}

// ─── Color math ────────────────────────────────────────────────────────────

function parseHex(c: string): [number, number, number] {
  const m = c.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Mix a hex color toward white (flow dots glow brighter than their line). */
export function mixWithWhite(color: string, t: number): string {
  const [r, g, b] = parseHex(color);
  return toHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

// ─── Tracks ────────────────────────────────────────────────────────────────

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Point at arclength `d` along a track (wraps past the end), into `out`. */
export function trackPointAt(track: StrandTrack, d: number, out: Vec3): void {
  const { pts, cum, total } = track;
  let target = total > 0 ? d % total : 0;
  if (target < 0) target += total;
  if (target === 0 && d !== 0) target = total; // d == total → the endpoint
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const d0 = cum[i - 1];
  const d1 = cum[i];
  const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
  const a = (i - 1) * 3;
  const b = i * 3;
  out[0] = pts[a] + (pts[b] - pts[a]) * t;
  out[1] = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t;
  out[2] = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * t;
}

function makeTrack(name: string, pts: Vec3[]): StrandTrack | null {
  if (pts.length < 2) return null;
  const flat = new Float32Array(pts.length * 3);
  const cum = new Float32Array(pts.length);
  pts.forEach((p, i) => {
    flat[i * 3] = p[0];
    flat[i * 3 + 1] = p[1];
    flat[i * 3 + 2] = p[2];
    cum[i] = i === 0 ? 0 : cum[i - 1] + dist(pts[i - 1], p);
  });
  const total = cum[cum.length - 1];
  if (total < 0.5) return null;
  return {
    name,
    color: mixWithWhite(oklchToHex(strandColor(name)), 0.35),
    pts: flat,
    cum,
    total,
  };
}

// ─── Geometry assembly ─────────────────────────────────────────────────────

function appendDedupe(acc: Vec3[], pts: Vec3[]): void {
  for (const p of pts) {
    const last = acc[acc.length - 1];
    if (!last || dist(last, p) > 1e-4) acc.push(p);
  }
}

/** Fillet a 3D-on-z0 polyline in the xy plane. */
function filletLine(raw: Vec3[], radius: number): Vec3[] {
  const out = filletManhattan(
    raw.map((p) => [p[0], p[1]] as [number, number]),
    radius,
  );
  return out.map(([x, y]) => [x, y, 0] as Vec3);
}

/**
 * Fillet a journey that ends in the NOW convergence: the journey corners get
 * `radius`, the single NOW corner gets NOW_CORNER_RADIUS. `raw` must end in
 * [..., (BUNDLE_X, exitY), (BUNDLE_X, nowY), (nowX, nowY)].
 */
function filletIntoNow(raw: Vec3[], radius: number): Vec3[] {
  const k = raw.length - 2; // the (BUNDLE_X, nowY) corner
  const head = filletLine(raw.slice(0, k + 1), radius); // …→ corner, corner sharp
  const tail = filletLine(raw.slice(k - 1), NOW_CORNER_RADIUS); // corner rounded
  // head ends at the corner; tail starts back at exitY. Both splice points
  // sit on the shared vertical (x = BUNDLE_X), so the join stays collinear.
  return [...head.slice(0, -1), ...tail.slice(1)];
}

export function computeStrandGeometry(
  scene: RegionScene,
  yLo: number,
  yHi: number,
): StrandSceneGeometry {
  const cfg = scene.cfg;
  const regions = scene.regions;
  if (regions.length === 0) return EMPTY_STRAND_GEOMETRY;

  // Full-scene scan: each strand's first/last carrier region (bundle
  // lifetime: extends past the window only where the strand has carriers
  // beyond it) plus the hash-stable ordering for the parallel offset.
  const firstRegion = new Map<string, number>();
  const lastRegion = new Map<string, number>();
  regions.forEach((region, ri) => {
    const seen = new Set<string>();
    for (const e of region.entries) for (const s of e.strands) seen.add(s);
    for (const s of seen) {
      if (!firstRegion.has(s)) firstRegion.set(s, ri);
      lastRegion.set(s, ri);
    }
  });
  const ordered = orderStrands(firstRegion.keys());
  const idxOf = new Map<string, number>();
  ordered.forEach((name, i) => idxOf.set(name, i));

  const yTopClamp = yHi + BUNDLE_OVERSCAN;
  const yBotClamp = yLo - BUNDLE_OVERSCAN;
  // Fillet radius: BIG by intent (user 2026-09-07: "圆角弧度可以更大一些，
  // 类似 100px") — filletManhattan clamps every corner to half its shorter
  // adjacent segment, so long bends (bundle departure/arrival, region gates)
  // get the full sweep while tight inter-row U-turns settle at pitch/2 (a
  // clean semicircle) and card-boundary folds stay small. Adjacent strands
  // (δ apart) sweep near-concentric arcs — the cable-bundle look.
  const filletR = 2.4;
  const band = { yLo: yBotClamp, yHi: yTopClamp };

  const lines: StrandLine[] = [];
  const tracks: StrandTrack[] = [];
  /** Per-strand per-window-region journeys (world coords), stitched below. */
  const strandWorks = new Map<string, { ri: number; pts: Vec3[] }[]>();
  const sigParts: string[] = [
    scene.level,
    String(Math.round(yLo * 2)),
    String(Math.round(yHi * 2)),
    String(scene.nowY.toFixed(2)),
  ];

  regions.forEach((region, ri) => {
    const top = region.originY + cfg.cardH / 2;
    if (regionBottom(region, cfg) > yHi || top < yLo) return;

    // Carriers per strand within this region (traversal indices).
    const carriers = new Map<string, Set<number>>();
    region.entries.forEach((e, i) => {
      for (const s of e.strands) {
        const set = carriers.get(s);
        if (set) set.add(i);
        else carriers.set(s, new Set([i]));
      }
    });
    if (carriers.size === 0) return;

    const perRow = Math.max(
      1,
      Math.round((region.grid.width + cfg.gapX) / (cfg.cardW + cfg.gapX)),
    );
    sigParts.push(
      `${region.key}@${perRow}:` +
        [...carriers]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, s]) => n + [...s].sort((a, b) => a - b).join("."))
          .join(","),
    );

    for (const [name, set] of carriers) {
      const delta = strandOffsetFor(idxOf.get(name)!);
      const path = strandRegionPath(region.grid, set, {
        cardW: cfg.cardW,
        cardH: cfg.cardH,
        gapX: cfg.gapX,
        gapY: cfg.gapY,
        perRow,
        bundleX: BUNDLE_X - region.originX,
      });
      if (!path) continue;
      const pts = path.map(
        (p): Vec3 => [
          region.originX + p.x,
          region.originY - (p.y + delta),
          0,
        ],
      );
      const works = strandWorks.get(name);
      if (works) works.push({ ri, pts });
      else strandWorks.set(name, [{ ri, pts }]);
    }
  });

  // ── Pass 2: stitch each strand's region journeys into one polyline ───────
  // Region journeys connect through the bundle automatically: every journey
  // starts and ends on the bundle vertical (x = BUNDLE_X), so consecutive
  // journeys join into the shared vertical segment.
  for (const [name, works] of strandWorks) {
    works.sort((a, b) => a.ri - b.ri);
    const hex = oklchToHex(strandColor(name));
    const raw: Vec3[] = [];
    const fades: { key: string; opacity: number; pts: Vec3[] }[] = [];

    const topExtended = firstRegion.get(name)! < works[0].ri;
    if (topExtended) raw.push([BUNDLE_X, yTopClamp - FADE_LEN, 0]);
    for (const w of works) appendDedupe(raw, w.pts);
    const exitY = raw[raw.length - 1][1];

    const lastRi = works[works.length - 1].ri;
    let intoNow = false;
    let bottomFadeY: number | null = null; // main-line end y of a bottom tip
    if (lastRegion.get(name)! > lastRi) {
      raw.push([BUNDLE_X, yBotClamp + FADE_LEN, 0]);
      bottomFadeY = yBotClamp + FADE_LEN;
    } else if (lastRi === regions.length - 1) {
      const [nowX, nowY] = [scene.nowPosition[0], scene.nowPosition[1]];
      appendDedupe(raw, [
        [BUNDLE_X, nowY, 0],
        [nowX, nowY, 0],
      ]);
      intoNow = true;
    } else {
      // Story over inside the window: a short trailing stub down the bundle.
      raw.push([BUNDLE_X, exitY - STUB_LEN, 0]);
      bottomFadeY = exitY - STUB_LEN;
    }

    if (topExtended) {
      fades.push(
        {
          key: `s:${name}:tf1`,
          opacity: FADE_OPACITY_1,
          pts: [
            [BUNDLE_X, yTopClamp - FADE_LEN, 0],
            [BUNDLE_X, yTopClamp - FADE_SEG, 0],
          ],
        },
        {
          key: `s:${name}:tf2`,
          opacity: FADE_OPACITY_2,
          pts: [
            [BUNDLE_X, yTopClamp - FADE_SEG, 0],
            [BUNDLE_X, yTopClamp, 0],
          ],
        },
      );
    }
    if (bottomFadeY !== null) {
      fades.push(
        {
          key: `s:${name}:bf1`,
          opacity: FADE_OPACITY_1,
          pts: [
            [BUNDLE_X, bottomFadeY, 0],
            [BUNDLE_X, bottomFadeY - FADE_SEG, 0],
          ],
        },
        {
          key: `s:${name}:bf2`,
          opacity: FADE_OPACITY_2,
          pts: [
            [BUNDLE_X, bottomFadeY - FADE_SEG, 0],
            [BUNDLE_X, bottomFadeY - FADE_LEN, 0],
          ],
        },
      );
    }

    const points = intoNow ? filletIntoNow(raw, filletR) : filletLine(raw, filletR);
    lines.push({
      key: `s:${name}`,
      color: hex,
      width: STRAND_LINE_WIDTH,
      opacity: STRAND_OPACITY,
      points,
    });
    for (const f of fades) {
      lines.push({
        key: f.key,
        color: hex,
        width: STRAND_LINE_WIDTH,
        opacity: f.opacity,
        points: f.pts,
      });
    }
    // Flow-dot track: the stitched polyline WITHOUT the fade tips.
    const track = makeTrack(name, points);
    if (track) tracks.push(track);
  }

  // NOW tail pass-through: strands alive at the end whose carrier regions all
  // sit ABOVE the window still pour into NOW when NOW itself is in the window.
  if (lastRegion.size > 0 && scene.nowY >= yLo && scene.nowY <= yHi) {
    const lastStrandRegion = Math.max(...lastRegion.values());
    const tailNames = ordered.filter(
      (name) =>
        !strandWorks.has(name) && lastRegion.get(name) === lastStrandRegion,
    );
    if (tailNames.length > 0) {
      sigParts.push(`nowtail:${tailNames.join(",")}`);
      const [nowX, nowY] = [scene.nowPosition[0], scene.nowPosition[1]];
      for (const name of tailNames) {
        const hex = oklchToHex(strandColor(name));
        const raw: Vec3[] = [
          [BUNDLE_X, yTopClamp - FADE_LEN, 0],
          [BUNDLE_X, nowY, 0],
          [nowX, nowY, 0],
        ];
        const points = filletLine(raw, NOW_CORNER_RADIUS);
        lines.push(
          {
            key: `s:${name}:now`,
            color: hex,
            width: STRAND_LINE_WIDTH,
            opacity: STRAND_OPACITY,
            points,
          },
          {
            key: `s:${name}:tf1`,
            color: hex,
            width: STRAND_LINE_WIDTH,
            opacity: FADE_OPACITY_1,
            points: [
              [BUNDLE_X, yTopClamp - FADE_LEN, 0],
              [BUNDLE_X, yTopClamp - FADE_SEG, 0],
            ],
          },
          {
            key: `s:${name}:tf2`,
            color: hex,
            width: STRAND_LINE_WIDTH,
            opacity: FADE_OPACITY_2,
            points: [
              [BUNDLE_X, yTopClamp - FADE_SEG, 0],
              [BUNDLE_X, yTopClamp, 0],
            ],
          },
        );
        const track = makeTrack(name, points);
        if (track) tracks.push(track);
      }
    }
  }

  return { lines, tracks, band, signature: sigParts.join("|") };
}
