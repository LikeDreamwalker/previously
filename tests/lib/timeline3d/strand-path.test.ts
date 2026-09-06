import { describe, it, expect } from "vitest";
import {
  serpentineGrid,
  type SerpentineGridConfig,
} from "@/lib/timeline3d/serpentine";
import {
  filletManhattan,
  strandRegionPath,
  EXIT_DOWN_RATIO,
  GATE_DOWN_RATIO,
  type StrandRegionPathConfig,
} from "@/lib/timeline3d/strand-path";

const GRID_CFG: SerpentineGridConfig = {
  cardW: 2,
  cardH: 1,
  gapX: 0.5,
  gapY: 0.4,
  perRow: 4,
};
// pitch = 1.4 · gridWidth = 9.5 · endXR = 9.75 · endXL = −0.25
// midY(r) = 1.4r · gapYOf(even r) = 1.4r − 0.7 · gapYOf(odd r) = 1.4r + 0.7

const PATH_CFG: StrandRegionPathConfig = { ...GRID_CFG, bundleX: -3 };

const PITCH = GRID_CFG.cardH + GRID_CFG.gapY;
const midY = (r: number) => r * PITCH;
const gapYOf = (r: number) =>
  midY(r) +
  (r % 2 === 0
    ? -(GRID_CFG.cardH / 2 + GRID_CFG.gapY / 2)
    : GRID_CFG.cardH / 2 + GRID_CFG.gapY / 2);
const END_XL = -GRID_CFG.gapX / 2;
const END_XR = 9.5 + GRID_CFG.gapX / 2;

function pathFor(count: number, carriers: number[]) {
  const grid = serpentineGrid(count, GRID_CFG);
  return strandRegionPath(grid, new Set(carriers), PATH_CFG);
}

describe("filletManhattan", () => {
  it("returns short polylines unchanged (first/last never move)", () => {
    expect(filletManhattan([[0, 0], [3, 0]], 0.5)).toEqual([[0, 0], [3, 0]]);
    expect(filletManhattan([[1, 2]], 0.5)).toEqual([[1, 2]]);
  });

  it("merges collinear monotonic runs before rounding", () => {
    const out = filletManhattan(
      [
        [0, 0],
        [0, 1],
        [0, 2],
        [2, 2],
      ],
      0.2,
    );
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([2, 2]);
    // The midpoint [0,1] is gone — no sampled point sits on it.
    expect(out.some((p) => p[0] === 0 && p[1] === 1)).toBe(false);
  });

  it("replaces each corner with an 8-segment quarter arc", () => {
    const out = filletManhattan(
      [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
      0.5,
    );
    expect(out).toHaveLength(1 + 9 + 1);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([2, 2]);
    // Arc endpoints are exactly radius away from the corner on each segment.
    expect(out[1][0]).toBeCloseTo(1.5, 10);
    expect(out[1][1]).toBeCloseTo(0, 10);
    expect(out[9][0]).toBeCloseTo(2, 10);
    expect(out[9][1]).toBeCloseTo(0.5, 10);
    // Every arc point is on the quarter circle around the corner center.
    for (const p of out.slice(1, 10)) {
      expect(Math.hypot(p[0] - 1.5, p[1] - 0.5)).toBeCloseTo(0.5, 10);
    }
  });

  it("clamps the radius to half the shorter adjacent segment", () => {
    const out = filletManhattan(
      [
        [0, 0],
        [0.4, 0],
        [0.4, 2],
      ],
      0.5,
    );
    // r = min(0.5, 0.4/2, 2/2) = 0.2 → first arc point at [0.2, 0].
    expect(out[1][0]).toBeCloseTo(0.2, 10);
    expect(out[1][1]).toBeCloseTo(0, 10);
  });
});

describe("strandRegionPath", () => {
  it("returns null when the strand has no carrier in the region", () => {
    expect(pathFor(12, [])).toBeNull();
  });

  it("enters horizontally from the bundle on row 0's lane (midline when card 0 is related, gap when not)", () => {
    const related = pathFor(12, [0, 1])!;
    expect(related[0]).toEqual({ x: PATH_CFG.bundleX, y: midY(0), kind: "enter" });
    expect(related[1]).toEqual({ x: END_XL, y: midY(0), kind: "enter" });

    const unrelated = pathFor(12, [5])!;
    expect(unrelated[0]).toEqual({
      x: PATH_CFG.bundleX,
      y: gapYOf(0),
      kind: "enter",
    });
    expect(unrelated[1].x).toBe(END_XL);
  });

  it("threads related cards ON the row midline at the card center", () => {
    const grid = serpentineGrid(12, GRID_CFG);
    const pts = pathFor(12, [0, 1, 2, 3, 4])!;
    const throughs = pts.filter(
      (p) => p.kind === "through" && grid.cards.some((c) => c.x === p.x),
    );
    expect(throughs).toHaveLength(5);
    for (let i = 0; i <= 4; i++) {
      const c = grid.cards[i];
      expect(
        throughs.some((p) => p.x === c.x && p.y === midY(c.row)),
      ).toBe(true);
    }
    // Every through-kind point (fold corners included) sits on a row midline.
    for (const p of pts.filter((p) => p.kind === "through")) {
      expect([0, 1, 2].some((r) => Math.abs(p.y - midY(r)) < 1e-10)).toBe(true);
    }
  });

  it("bypasses unrelated cards ON the gap midline — and consecutive unrelated cards never bounce between lanes", () => {
    const grid = serpentineGrid(12, GRID_CFG);
    const pts = pathFor(12, [0, 4])!;
    // Cards 1,2,3 (row 0, unrelated): bypass points on the upper gap line.
    for (let i = 1; i <= 3; i++) {
      const c = grid.cards[i];
      expect(
        pts.some(
          (p) => p.kind === "bypass" && p.x === c.x && p.y === gapYOf(0),
        ),
      ).toBe(true);
    }
    // Between the fold after card 0 and the U-turn, nothing touches midY(0).
    const foldIdx = pts.findIndex((p) => p.y === gapYOf(0));
    const uturnIdx = pts.findIndex((p) => p.kind === "uturn");
    for (const p of pts.slice(foldIdx, uturnIdx)) {
      expect(Math.abs(p.y - midY(0))).toBeGreaterThan(1e-10);
    }
  });

  it("turns at the row's travel end, midline → midline while riding related range", () => {
    const pts = pathFor(12, Array.from({ length: 12 }, (_, i) => i))!;
    const uturns = pts.filter((p) => p.kind === "uturn");
    // Row 0 (L→R) turns at endXR: midY(0) → midY(1); row 1 at END_XL.
    expect(uturns).toEqual([
      { x: END_XR, y: midY(0), kind: "uturn" },
      { x: END_XR, y: midY(1), kind: "uturn" },
      { x: END_XL, y: midY(1), kind: "uturn" },
      { x: END_XL, y: midY(2), kind: "uturn" },
    ]);
  });

  it("early return: rides the gap lanes to an R→L row's left end, drops, and runs left to the bundle", () => {
    const pts = pathFor(12, [0, 1, 2, 3, 4])!;
    const exits = pts.filter((p) => p.kind === "exit");
    const exitY = midY(1) + GRID_CFG.cardH * EXIT_DOWN_RATIO;
    expect(exits).toEqual([
      { x: END_XL, y: gapYOf(1), kind: "exit" },
      { x: END_XL, y: exitY, kind: "exit" },
      { x: PATH_CFG.bundleX, y: exitY, kind: "exit" },
    ]);
    expect(pts.some((p) => p.kind === "gate")).toBe(false);
  });

  it("gate: a strand related to the region's last card drops below it and runs left", () => {
    const grid = serpentineGrid(12, GRID_CFG);
    const pts = pathFor(12, Array.from({ length: 12 }, (_, i) => i))!;
    const lastCard = grid.cards[11];
    const yGate = midY(lastCard.row) + GRID_CFG.cardH * GATE_DOWN_RATIO;
    expect(pts.filter((p) => p.kind === "gate")).toEqual([
      { x: lastCard.x, y: yGate, kind: "gate" },
      { x: PATH_CFG.bundleX, y: yGate, kind: "gate" },
    ]);
  });

  it("trailing that runs out of rows on an even row falls through the gate", () => {
    // Carrier = index 7 (end of row 1); the trailing ride over row 2 (even)
    // reaches the region's last card before any odd row's left end.
    const grid = serpentineGrid(12, GRID_CFG);
    const pts = pathFor(12, [7])!;
    const lastCard = grid.cards[11];
    const yGate = midY(lastCard.row) + GRID_CFG.cardH * GATE_DOWN_RATIO;
    const gates = pts.filter((p) => p.kind === "gate");
    expect(gates).toEqual([
      { x: lastCard.x, y: yGate, kind: "gate" },
      { x: PATH_CFG.bundleX, y: yGate, kind: "gate" },
    ]);
    expect(pts.some((p) => p.kind === "exit")).toBe(false);
  });

  it("single-carrier strand in a single-card region: enter → through → gate", () => {
    const pts = pathFor(1, [0])!;
    expect(pts.map((p) => p.kind)).toEqual([
      "enter",
      "enter",
      "through",
      "gate",
      "gate",
    ]);
    expect(pts[pts.length - 1].x).toBe(PATH_CFG.bundleX);
  });

  it("is pure Manhattan: consecutive waypoints differ on exactly one axis", () => {
    for (const carriers of [[0, 4], [7], [0, 1, 2, 3, 4], [5], [0, 11]]) {
      const pts = pathFor(12, carriers)!;
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i].x - pts[i - 1].x);
        const dy = Math.abs(pts[i].y - pts[i - 1].y);
        expect(Math.min(dx, dy)).toBeLessThan(1e-10);
        expect(Math.max(dx, dy)).toBeGreaterThan(1e-10);
      }
    }
  });
});
