import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  computeTimelineLayout,
  zoomStateForLevel,
  strandColor,
  strandOffset,
  oklchToHex,
  coreXAt,
  isRealBoundaryBefore,
  STRAND_PALETTE,
  STRAND_LANE_MIN,
  STRAND_LANE_MAX,
  BASE_GAP,
  CLUSTER_GAP,
  BOUNDARY_GAP,
  BEAD_BASE_SIZE,
  EMBER_BRIGHTNESS,
  NOW_GAP,
  WOBBLE_AMP,
  LEVEL_DISTANCES,
  MAX_ZOOM_LEVEL,
} from "@/lib/timeline3d/layout";

let seq = 0;
function entry(overrides: Partial<TimelineSliceEntry> = {}): TimelineSliceEntry {
  seq += 1;
  const id = overrides.id ?? `2026-08-${String(seq).padStart(2, "0")}-1000`;
  return {
    id,
    date: id.slice(0, 10),
    start: overrides.start ?? `${id.slice(0, 10)}T10:00:00.000Z`,
    status: "closed",
    focus: "f",
    summary: "s",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
    closed_by: "idle_gap",
    ...overrides,
  };
}

describe("computeTimelineLayout — time → Y (vertical, Rev 2)", () => {
  it("y is strictly DECREASING with time (past up, now down), regardless of close reasons", () => {
    const entries = [
      entry({ id: "2026-08-01-1000", closed_by: "idle_gap" }),
      entry({ id: "2026-08-01-1200", closed_by: "time_cap" }),
      entry({
        id: "2026-08-01-1300",
        closed_by: "capacity",
        continues_from: "2026-08-01-1200",
      }),
      entry({ id: "2026-08-05-0900", closed_by: "context_lost" }),
      entry({ id: "2026-08-05-2300", closed_by: undefined }),
    ];
    const { nodes } = computeTimelineLayout(entries);
    expect(nodes).toHaveLength(5);
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].y).toBeLessThan(nodes[i - 1].y);
      // Nodes live on the core line: x is the wobble of their y, z = 0.
      expect(nodes[i].position[0]).toBeCloseTo(coreXAt(nodes[i].y), 10);
      expect(nodes[i].position[1]).toBe(nodes[i].y);
      expect(nodes[i].position[2]).toBe(0);
    }
  });

  it("returns an empty layout for an empty catalog", () => {
    const layout = computeTimelineLayout([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.strands).toEqual([]);
    expect(layout.yTop).toBe(0);
    expect(layout.nowY).toBe(-NOW_GAP);
  });

  it("carries catalog tags onto the node (T1 chip capsule data, Rev 3)", () => {
    const { nodes } = computeTimelineLayout([
      entry({ id: "2026-08-01-1000", tags: ["rust", "memory"] }),
      entry({ id: "2026-08-02-1000" }),
    ]);
    expect(nodes[0].tags).toEqual(["rust", "memory"]);
    expect(nodes[1].tags).toEqual([]);
  });

  it("carries the card data (turns / tone / loops / decisions / end, Rev 4)", () => {
    const { nodes } = computeTimelineLayout([
      entry({
        id: "2026-08-01-1000",
        end: "2026-08-01T10:42:00Z",
        turn_count: 7,
        tone: "focused",
        open_loops: ["ship it"],
        decisions: ["use r3f"],
      }),
    ]);
    expect(nodes[0].turnCount).toBe(7);
    expect(nodes[0].end).toBe("2026-08-01T10:42:00Z");
    expect(nodes[0].tone).toBe("focused");
    expect(nodes[0].openLoops).toEqual(["ship it"]);
    expect(nodes[0].decisions).toEqual(["use r3f"]);
  });

  it("sorts defensively when the catalog is out of order", () => {
    const a = entry({ id: "2026-08-02-1000", start: "2026-08-02T10:00:00Z" });
    const b = entry({ id: "2026-08-01-1000", start: "2026-08-01T10:00:00Z" });
    const { nodes } = computeTimelineLayout([a, b]);
    expect(nodes[0].id).toBe("2026-08-01-1000");
    expect(nodes[1].y).toBeLessThan(nodes[0].y);
  });
});

describe("computeTimelineLayout — gap policy", () => {
  it("checkpoint chains (continues_from) cluster below the base gap", () => {
    const prev = entry({ id: "2026-08-01-1000", closed_by: "time_cap" });
    const next = entry({
      id: "2026-08-01-1100",
      closed_by: "idle_gap",
      continues_from: "2026-08-01-1000",
    });
    const { nodes } = computeTimelineLayout([prev, next]);
    const gap = nodes[0].y - nodes[1].y;
    expect(gap).toBe(CLUSTER_GAP);
    expect(gap).toBeLessThan(BASE_GAP);
  });

  it("an idle_gap boundary leaves a longer gap than a normal close", () => {
    const mk = (prevClosedBy: string | undefined, link?: string) => {
      const prev = entry({ id: "2026-08-01-1000", closed_by: prevClosedBy });
      const next = entry({
        id: "2026-08-02-1000",
        closed_by: "idle_gap",
        continues_from: link,
      });
      const { nodes } = computeTimelineLayout([prev, next]);
      return nodes[0].y - nodes[1].y;
    };
    const normal = mk("time_cap"); // no link → normal conversation gap
    const idle = mk("idle_gap");
    const legacy = mk(undefined); // no closed_by → real boundary (§1.4)
    expect(idle).toBeGreaterThanOrEqual(BOUNDARY_GAP);
    expect(idle).toBeGreaterThan(normal);
    expect(legacy).toBeGreaterThanOrEqual(BOUNDARY_GAP);
  });

  it("isRealBoundaryBefore: checkpoint link always wins over the close reason", () => {
    const prev = entry({ id: "a", closed_by: "idle_gap" });
    expect(
      isRealBoundaryBefore(prev, entry({ id: "b", continues_from: "a" })),
    ).toBe(false);
    expect(isRealBoundaryBefore(prev, entry({ id: "c" }))).toBe(true);
  });

  it("node size grows with turn_count and brightness fades toward the past", () => {
    const entries = [
      entry({ id: "2026-08-01-1000", turn_count: 1 }),
      entry({ id: "2026-08-02-1000", turn_count: 9 }),
      entry({ id: "2026-08-03-1000", turn_count: 16 }),
    ];
    const { nodes } = computeTimelineLayout(entries);
    expect(nodes[0].size).toBeLessThan(nodes[1].size);
    expect(nodes[1].size).toBeLessThan(nodes[2].size);
    expect(nodes[0].size).toBeGreaterThanOrEqual(BEAD_BASE_SIZE);
    // Oldest is dimmest, newest is at full brightness.    expect(nodes[0].brightness).toBeLessThan(nodes[2].brightness);
    expect(nodes[2].brightness).toBeCloseTo(1, 5);
    expect(nodes[0].brightness).toBeGreaterThanOrEqual(EMBER_BRIGHTNESS);
  });

  it("marks the first node of each calendar day", () => {
    const { nodes } = computeTimelineLayout([
      entry({ id: "2026-08-01-1000" }),
      entry({ id: "2026-08-01-2200" }),
      entry({ id: "2026-08-02-0900" }),
    ]);
    expect(nodes.map((n) => n.dayStart)).toEqual([true, false, true]);
  });
});

describe("computeTimelineLayout — the NOW convergence point", () => {
  it("rests NOW_GAP below the newest node, on the core line", () => {
    const layout = computeTimelineLayout([
      entry({ id: "2026-08-01-1000" }),
      entry({ id: "2026-08-02-1000" }),
    ]);
    const newest = layout.nodes[layout.nodes.length - 1];
    expect(layout.nowY).toBeCloseTo(newest.y - NOW_GAP, 10);
    expect(layout.nowPosition[0]).toBeCloseTo(coreXAt(layout.nowY), 10);
    expect(layout.nowPosition[1]).toBe(layout.nowY);
    expect(layout.nowPosition[2]).toBe(0);
    expect(layout.yTop).toBe(layout.nodes[0].y);
  });
});

describe("strand identity (§5.0 palette + cable-bundle offsets)", () => {
  it("is deterministic: same name → same color/offset", () => {
    expect(strandColor("agent-memory")).toBe(strandColor("agent-memory"));
    expect(strandOffset("agent-memory")).toEqual(strandOffset("agent-memory"));
  });

  it("colors always come from the five-color oklch palette", () => {
    for (const name of ["agent-memory", "client-cli", "evolution", "x", "线索", "s3"]) {
      expect(STRAND_PALETTE).toContain(strandColor(name));
    }
  });

  it("offsets stay within the bundle cross-section ring", () => {
    for (const name of ["a", "b", "c", "strand-π", "线索", "zz"]) {
      const [x, z] = strandOffset(name);
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThanOrEqual(STRAND_LANE_MIN - 1e-9);
      expect(r).toBeLessThanOrEqual(STRAND_LANE_MAX + 1e-9);
    }
  });

  it("the wobble stays within ±WOBBLE_AMP", () => {
    for (const y of [0, -10, -333.7, -5000]) {
      expect(Math.abs(coreXAt(y))).toBeLessThanOrEqual(WOBBLE_AMP + 1e-9);
    }
  });
});

describe("computeTimelineLayout — strand carriers", () => {
  it("collects every carrier node index per strand, skipping gaps", () => {
    const entries = [
      entry({ id: "2026-08-01-1000", strands: ["a", "b"] }),
      entry({ id: "2026-08-02-1000", strands: ["a"] }),
      entry({ id: "2026-08-03-1000", strands: [] }),
      entry({ id: "2026-08-04-1000", strands: ["a", "b"] }),
    ];
    const { strands } = computeTimelineLayout(entries);
    const byName = new Map(strands.map((s) => [s.name, s]));
    expect(byName.get("a")!.carriers).toEqual([0, 1, 3]);
    expect(byName.get("b")!.carriers).toEqual([0, 3]);
    for (const s of strands) {
      expect(s.color).toBe(strandColor(s.name));
      expect(s.offset).toEqual(strandOffset(s.name));
    }
  });

  it("a strand carried by a single slice still gets a lane (it joins NOW)", () => {
    const { strands } = computeTimelineLayout([
      entry({ id: "2026-08-01-1000", strands: ["solo"] }),
      entry({ id: "2026-08-02-1000" }),
    ]);
    expect(strands).toHaveLength(1);
    expect(strands[0].carriers).toEqual([0]);
  });
});

describe("scale discipline — 200 strands × 500 nodes", () => {
  it("computes without quadratic blow-up", () => {
    const POOL = 200;
    const N = 500;
    const entries: TimelineSliceEntry[] = [];
    for (let i = 0; i < N; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String(1 + Math.floor(i / 28) % 12).padStart(2, "0");
      // ~8 strands per node from a deterministic pool of 200.
      const strands: string[] = [];
      for (let k = 0; k < 8; k++) strands.push(`strand-${(i * 7 + k * 31) % POOL}`);
      entries.push(
        entry({
          id: `2026-${month}-${day}-${String(1000 + (i % 50)).padStart(4, "0")}`,
          start: `2026-${month}-${day}T10:00:00.000Z`,
          strands: [...new Set(strands)],
          closed_by: i % 5 === 4 ? "idle_gap" : "time_cap",
        }),
      );
    }
    const t0 = performance.now();
    const layout = computeTimelineLayout(entries);
    const ms = performance.now() - t0;
    expect(layout.nodes).toHaveLength(N);
    expect(layout.strands.length).toBeLessThanOrEqual(POOL);
    expect(layout.strands.length).toBeGreaterThan(100);
    // Generous bound: the real cost is O(total strand incidences) ≈ 4k.
    expect(ms).toBeLessThan(300);
  });
});

describe("zoomStateForLevel — level = information density (§R5.1)", () => {
  it("maps each level to its fixed camera distance", () => {
    for (let l = 0; l <= MAX_ZOOM_LEVEL; l++) {
      expect(zoomStateForLevel(l as 0).distance).toBe(LEVEL_DISTANCES[l]);
    }
    // Distances shrink monotonically from far (Atlas) to near (Conversation).
    for (let l = 1; l <= MAX_ZOOM_LEVEL; l++) {
      expect(LEVEL_DISTANCES[l]).toBeLessThan(LEVEL_DISTANCES[l - 1]);
    }
  });

  it("gates the info layers by level", () => {
    expect(zoomStateForLevel(0).dateMarkers).toBe(true); // L0 always has day labels
    expect(zoomStateForLevel(0).timePoints).toBe(false);
    expect(zoomStateForLevel(1).timePoints).toBe(true);
    expect(zoomStateForLevel(0).cards).toBe(false);
    expect(zoomStateForLevel(1).cards).toBe(true);
    expect(zoomStateForLevel(2).strandArcs).toBe(false);
    expect(zoomStateForLevel(3).strandArcs).toBe(true);
    expect(zoomStateForLevel(3).turns).toBe(false);
    expect(zoomStateForLevel(4).turns).toBe(true);
  });

  it("cardTier is 1:1 with the level", () => {
    for (let l = 0; l <= MAX_ZOOM_LEVEL; l++) {
      const zs = zoomStateForLevel(l as 0);
      expect(zs.cardTier).toBe(l);
      expect(zs.cards).toBe(zs.cardTier >= 1);
    }
  });
});

describe("oklchToHex", () => {
  it("converts every palette entry to a valid hex color", () => {
    for (const c of STRAND_PALETTE) {
      expect(oklchToHex(c)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps greys channel-neutral", () => {
    const hex = oklchToHex("oklch(0.556 0 0)");
    expect(hex.slice(1, 3)).toBe(hex.slice(3, 5));
    expect(hex.slice(3, 5)).toBe(hex.slice(5, 7));
  });

  it("passes through non-oklch strings unchanged", () => {
    expect(oklchToHex("#a1b2c3")).toBe("#a1b2c3");
  });
});
