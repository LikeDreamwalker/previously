/**
 * Left time rail geometry (v0.10 §1.3 Rev 2): viewport filtering, edge
 * clamping and the label gap of `computeRailNodes`.
 */
import { describe, it, expect } from "vitest";
import {
  computeRailNodes,
  RAIL_EDGE_PAD_PX,
  RAIL_MIN_GAP_PX,
} from "@/lib/chat/time-rail";

const ISO = "2026-08-11T10:00:00.000Z";
const VH = 800;

function input(top: number, height = 56, over: Partial<{ key: string; timeIso: string }> = {}) {
  return { key: over.key ?? `k-${top}`, timeIso: over.timeIso ?? ISO, top, height };
}

describe("computeRailNodes", () => {
  it("anchors a fully visible item at its top", () => {
    const nodes = computeRailNodes([input(100)], VH);
    expect(nodes).toEqual([{ key: "k-100", timeIso: ISO, y: 100 }]);
  });

  it("drops items entirely above or below the viewport", () => {
    const nodes = computeRailNodes(
      [input(-80, 40), input(900, 60), input(200)],
      VH,
    );
    expect(nodes.map((n) => n.key)).toEqual(["k-200"]);
  });

  it("clamps straddling items to the padded edges", () => {
    const nodes = computeRailNodes(
      [input(-100, 200), input(VH - 30, 200)],
      VH,
    );
    expect(nodes.map((n) => n.y)).toEqual([
      RAIL_EDGE_PAD_PX,
      VH - 30,
    ]);
    // One strictly past the bottom edge clamps onto the bottom pad.
    const [bottom] = computeRailNodes([input(VH - 4, 40)], VH);
    expect(bottom.y).toBe(VH - RAIL_EDGE_PAD_PX);
  });

  it("enforces the label gap — a closer node collapses, the one above wins", () => {
    const nodes = computeRailNodes(
      [input(100), input(100 + RAIL_MIN_GAP_PX - 1), input(100 + RAIL_MIN_GAP_PX)],
      VH,
    );
    expect(nodes.map((n) => n.y)).toEqual([100, 100 + RAIL_MIN_GAP_PX]);
  });

  it("gap-filtered edge clusters collapse to a single node", () => {
    // Three items straddling the top edge all clamp to the same pad → one node.
    const nodes = computeRailNodes(
      [input(-50, 100), input(-40, 90), input(-10, 60)],
      VH,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].y).toBe(RAIL_EDGE_PAD_PX);
  });

  it("drops empty or invalid timestamps", () => {
    const nodes = computeRailNodes(
      [input(100, 56, { timeIso: "" }), input(200, 56, { timeIso: "not-a-date" })],
      VH,
    );
    expect(nodes).toEqual([]);
  });

  it("returns nodes sorted by y regardless of input order", () => {
    const nodes = computeRailNodes([input(300), input(100), input(500)], VH);
    expect(nodes.map((n) => n.y)).toEqual([100, 300, 500]);
  });

  it("degenerates to nothing on a viewport too short to pad", () => {
    expect(computeRailNodes([input(5)], RAIL_EDGE_PAD_PX * 2)).toEqual([]);
  });

  it("an empty input yields no nodes", () => {
    expect(computeRailNodes([], VH)).toEqual([]);
  });
});
