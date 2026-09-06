import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { computeRegionScene } from "@/lib/timeline3d/regions";
import {
  BUNDLE_X,
  computeStrandGeometry,
  mixWithWhite,
  orderStrands,
  strandOffsetFor,
  trackPointAt,
  STRAND_LINE_WIDTH,
  STRAND_OPACITY,
  type Vec3,
} from "@/lib/timeline3d/strand-scene";

let seq = 0;
function entry(
  date: string,
  start: string,
  strands: string[],
): TimelineSliceEntry {
  seq += 1;
  return {
    id: `${date}-${String(seq).padStart(4, "0")}`,
    date,
    start: `${date}T${start}:00.000Z`,
    status: "closed",
    focus: `f${seq}`,
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands,
    needs_marking: false,
  };
}

// Two days, three slices each; strands: alpha everywhere, beta everywhere too
// (both alive in the newest region).
const entries = [
  entry("2026-08-01", "08:00", ["alpha", "beta"]),
  entry("2026-08-01", "10:00", ["alpha"]),
  entry("2026-08-01", "12:00", ["beta"]),
  entry("2026-08-02", "08:00", ["alpha"]),
  entry("2026-08-02", "10:00", ["alpha", "beta"]),
  entry("2026-08-02", "12:00", ["alpha"]),
];
const scene = computeRegionScene(entries, "day", 3);
const yLo = scene.nowY - 5;
const yHi = scene.yTop + 5;

const mainLine = (geom: ReturnType<typeof computeStrandGeometry>, name: string) =>
  geom.lines.find((l) => l.key === `s:${name}`)!;

describe("ordering & parallel offset", () => {
  it("ordering is hash-stable, not insertion order", () => {
    const a = orderStrands(["beta", "alpha", "gamma"]);
    const b = orderStrands(["gamma", "alpha", "beta"]);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strand offsets are small, distinct within a lap, and ordered", () => {
    for (let i = 0; i < 10; i++) {
      expect(Math.abs(strandOffsetFor(i))).toBeLessThanOrEqual(0.2);
      if (i > 0) {
        expect(strandOffsetFor(i)).toBeGreaterThan(strandOffsetFor(i - 1));
      }
    }
    expect(strandOffsetFor(0)).toBeCloseTo(-4.5 * 0.042, 10);
  });
});

describe("computeStrandGeometry", () => {
  it("empty scene → empty geometry (with a zero band)", () => {
    const empty = computeRegionScene([], "day", 3);
    const geom = computeStrandGeometry(empty, -5, 5);
    expect(geom.lines).toEqual([]);
    expect(geom.tracks).toEqual([]);
    expect(geom.band).toEqual({ yLo: 0, yHi: 0 });
    expect(geom.signature).toBe("empty");
  });

  it("draws one main line per strand present in the window", () => {
    const geom = computeStrandGeometry(scene, yLo, yHi);
    expect(mainLine(geom, "alpha")).toBeDefined();
    expect(mainLine(geom, "beta")).toBeDefined();
    for (const l of geom.lines) {
      expect(l.width).toBe(STRAND_LINE_WIDTH);
      expect(l.points.length).toBeGreaterThanOrEqual(2);
      // No bundles anymore: every line is a strand line at base opacity or a
      // fade tip below it.
      expect(l.opacity).toBeLessThanOrEqual(STRAND_OPACITY);
    }
    // The band spans the window + overscan.
    expect(geom.band.yHi).toBeCloseTo(yHi + 1.5, 10);
    expect(geom.band.yLo).toBeCloseTo(yLo - 1.5, 10);
  });

  it("bundle verticals are collinear: fade tips and the longest vertical of every strand sit at exactly BUNDLE_X", () => {
    const geom = computeStrandGeometry(scene, yLo, yHi);
    for (const l of geom.lines) {
      if (/:[tb]f[12]$/.test(l.key)) {
        for (const p of l.points) expect(p[0]).toBe(BUNDLE_X);
      }
    }
    for (const name of ["alpha", "beta"]) {
      const pts = mainLine(geom, name).points;
      // Every journey starts on the bundle vertical.
      expect(pts[0][0]).toBeCloseTo(BUNDLE_X, 10);
      // The longest vertical run is the NOW descent / window extension —
      // always on the shared bundle x (in-region folds are ≤ a row pitch).
      let best = 0;
      let bestX = 0;
      for (let i = 1; i < pts.length; i++) {
        if (Math.abs(pts[i][0] - pts[i - 1][0]) > 1e-9) continue;
        const len = Math.abs(pts[i][1] - pts[i - 1][1]);
        if (len > best) {
          best = len;
          bestX = pts[i][0];
        }
      }
      expect(best).toBeGreaterThan(1);
      expect(bestX).toBeCloseTo(BUNDLE_X, 10);
    }
  });

  it("keeps strands parallel: the same journey waypoint differs only by the fixed δ", () => {
    const geom = computeStrandGeometry(scene, yLo, yHi);
    const ordered = orderStrands(["alpha", "beta"]);
    const dA = strandOffsetFor(ordered.indexOf("alpha"));
    const dB = strandOffsetFor(ordered.indexOf("beta"));
    expect(dA).not.toBe(dB);
    // Both strands carry the very first card → both enter on row 0's
    // midline: first point y = originY − δ, so y + δ is identical.
    const a = mainLine(geom, "alpha").points[0];
    const b = mainLine(geom, "beta").points[0];
    expect(a[0]).toBeCloseTo(BUNDLE_X, 10);
    expect(b[0]).toBeCloseTo(BUNDLE_X, 10);
    expect(a[1] + dA).toBeCloseTo(b[1] + dB, 10);
  });

  it("extends past the window with a two-segment fade tip (0.22 → 0.09), collinear at BUNDLE_X", () => {
    // Window covers only the newer region: alpha still has carriers above.
    const top = scene.regions[1].originY;
    const hi = top + 0.5;
    const geom = computeStrandGeometry(scene, scene.nowY - 5, hi);
    const main = mainLine(geom, "alpha");
    expect(main.points[0][0]).toBeCloseTo(BUNDLE_X, 10);
    expect(main.points[0][1]).toBeCloseTo(hi + 1.5 - 1.2, 10);
    const f1 = geom.lines.find((l) => l.key === "s:alpha:tf1")!;
    const f2 = geom.lines.find((l) => l.key === "s:alpha:tf2")!;
    expect(f1.opacity).toBe(0.22);
    expect(f2.opacity).toBe(0.09);
    expect(f1.points).toEqual([
      [BUNDLE_X, hi + 1.5 - 1.2, 0],
      [BUNDLE_X, hi + 1.5 - 0.6, 0],
    ]);
    expect(f2.points).toEqual([
      [BUNDLE_X, hi + 1.5 - 0.6, 0],
      [BUNDLE_X, hi + 1.5, 0],
    ]);
    // Fade tips stay out of the flow-dot track.
    const track = geom.tracks.find((t) => t.name === "alpha")!;
    expect(track.pts[1]).toBeCloseTo(hi + 1.5 - 1.2, 6);
  });

  it("strands alive in the newest region converge into NOW: vertical down the bundle, one rounded corner, horizontal to the spine", () => {
    const geom = computeStrandGeometry(scene, yLo, yHi);
    const nowX = scene.nowPosition[0];
    const nowY = scene.nowPosition[1];
    const main = mainLine(geom, "alpha");
    const last = main.points[main.points.length - 1];
    expect(last[0]).toBeCloseTo(nowX, 6);
    expect(last[1]).toBeCloseTo(nowY, 6);
    // The corner at (BUNDLE_X, nowY) is rounded with radius ≤ 0.5: an arc
    // start on the vertical above nowY and an arc end on the horizontal.
    const r = Math.min(0.5, (nowX - BUNDLE_X) / 2);
    expect(
      main.points.some(
        (p) =>
          Math.abs(p[0] - BUNDLE_X) < 1e-6 &&
          p[1] > nowY + 0.05 &&
          p[1] <= nowY + r + 1e-6,
      ),
    ).toBe(true);
    expect(
      main.points.some(
        (p) =>
          Math.abs(p[1] - nowY) < 1e-6 && p[0] > BUNDLE_X && p[0] < nowX,
      ),
    ).toBe(true);
    // The track ends exactly at NOW.
    const track = geom.tracks.find((t) => t.name === "alpha")!;
    const n = track.pts.length;
    expect(track.pts[n - 3]).toBeCloseTo(nowX, 6);
    expect(track.pts[n - 2]).toBeCloseTo(nowY, 6);
  });

  it("a strand whose story ends before the newest region gets a stub + fade, not NOW", () => {
    const es = [
      entry("2026-08-01", "08:00", ["old"]),
      entry("2026-08-01", "10:00", ["old"]),
      entry("2026-08-03", "08:00", ["alpha"]),
      entry("2026-08-03", "10:00", ["alpha"]),
    ];
    const s2 = computeRegionScene(es, "day", 3);
    const geom = computeStrandGeometry(s2, s2.nowY - 5, s2.yTop + 5);
    const old = mainLine(geom, "old");
    const lastY = old.points[old.points.length - 1][1];
    expect(lastY).toBeGreaterThan(s2.nowY); // ended above NOW
    expect(geom.lines.some((l) => l.key === "s:old:bf1")).toBe(true);
    expect(geom.lines.some((l) => l.key === "s:old:bf2")).toBe(true);
    const track = geom.tracks.find((t) => t.name === "old")!;
    expect(track.pts[track.pts.length - 2]).toBeCloseTo(lastY, 6);
  });

  it("NOW tail: end-alive strands pour into NOW even when their regions scrolled off", () => {
    // Window around NOW only — every carrier region is above it.
    const geom = computeStrandGeometry(scene, scene.nowY - 2, scene.nowY + 1);
    const tails = geom.lines.filter((l) => l.key.endsWith(":now"));
    expect(tails.map((l) => l.key).sort()).toEqual(["s:alpha:now", "s:beta:now"]);
    for (const t of tails) {
      const last = t.points[t.points.length - 1];
      expect(last[0]).toBeCloseTo(scene.nowPosition[0], 6);
      expect(last[1]).toBeCloseTo(scene.nowPosition[1], 6);
      // Manhattan shape: vertical at BUNDLE_X, then horizontal into the spine.
      expect(t.points[0][0]).toBeCloseTo(BUNDLE_X, 6);
      // Top fade tips ride along.
      const name = t.key.split(":")[1];
      expect(geom.lines.some((l) => l.key === `s:${name}:tf2`)).toBe(true);
    }
  });

  it("signature is stable for identical inputs and moves with the window", () => {
    const a = computeStrandGeometry(scene, yLo, yHi);
    const b = computeStrandGeometry(scene, yLo, yHi);
    expect(a.signature).toBe(b.signature);
    const c = computeStrandGeometry(scene, yLo - 1, yHi);
    expect(c.signature).not.toBe(a.signature);
  });

  it("hour level (one card per row) renders simple in-out paths", () => {
    const es = [
      entry("2026-08-01", "08:00", ["alpha"]),
      entry("2026-08-01", "08:20", ["alpha", "beta"]),
      entry("2026-08-01", "08:40", ["beta"]),
    ];
    const s5 = computeRegionScene(es, "hour", 1);
    const geom = computeStrandGeometry(s5, s5.nowY - 5, s5.yTop + 5);
    expect(geom.lines.length).toBeGreaterThan(0);
    expect(geom.tracks.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("trackPointAt interpolates along the arclength table", () => {
    const geom = computeStrandGeometry(scene, yLo, yHi);
    const track = geom.tracks[0];
    const out: Vec3 = [0, 0, 0];
    trackPointAt(track, 0, out);
    expect(out[0]).toBeCloseTo(track.pts[0], 6);
    expect(out[1]).toBeCloseTo(track.pts[1], 6);
    trackPointAt(track, track.total, out);
    const n = track.pts.length;
    expect(out[0]).toBeCloseTo(track.pts[n - 3], 6);
    expect(out[1]).toBeCloseTo(track.pts[n - 2], 6);
    trackPointAt(track, track.total / 2, out);
    expect(out[1]).toBeLessThan(track.pts[1] + 0.01);
    expect(out[1]).toBeGreaterThan(track.pts[n - 2] - 0.01);
  });
});

describe("mixWithWhite", () => {
  it("moves channels toward 255", () => {
    expect(mixWithWhite("#000000", 1)).toBe("#ffffff");
    expect(mixWithWhite("#000000", 0)).toBe("#000000");
  });
});
