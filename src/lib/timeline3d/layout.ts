/**
 * 3D timeline layout — pure functions mapping the timeline catalog to spatial
 * coordinates. No three.js imports here: the scene consumes plain
 * numbers/strings, and the module stays unit-testable in a node environment.
 *
 * Spatial model (doc/design/v0.10.0-memory-viz.md §5.1, Rev 2 — the vertical
 * 2.5D cable-bundle model):
 * - The core timeline is VERTICAL: time maps to Y, past at the top, the "now"
 *   end at the bottom (same direction as the chat stream). y DECREASES toward
 *   now; NOW itself is a convergence point below the newest node.
 * - The core line is STRAIGHT (Rev 4, per user): `coreXAt` keeps its wobble
 *   signature but WOBBLE_AMP is 0 — the spine reads as one clean rule; the
 *   organic feel comes from the gaps, not the geometry.
 * - Time discontinuity is expressed as vertical distance: checkpoint chains
 *   (`continues_from`) cluster tight; after a real boundary (idle_gap /
 *   context_lost / legacy no closed_by) the line leaves a long gap.
 * - Strand threads return at L3+ as semi-transparent arcs (Rev 5 §R5.3):
 *   each strand's curve passes through its carrier nodes, laterally seated
 *   by the `strandOffset` lane (the cable-bundle cross-section), weaving
 *   around and through the cards.
 * - All threads re-converge into the NOW point at the very bottom.
 */

import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

// ─── Tuning constants ──────────────────────────────────────────────────────

/** Base Y distance between two consecutive slices in one conversation. */
export const BASE_GAP = 3.2;
/** Y gap between checkpoint-linked slices (time_cap/capacity chain). */
export const CLUSTER_GAP = 1.3;
/** Y gap after a real boundary (idle_gap / context_lost / legacy). */
export const BOUNDARY_GAP = 8;
/** Extra Y per hour of real elapsed time, capped by TIME_COMPONENT_MAX. */
export const HOUR_SCALE = 0.12;
export const TIME_COMPONENT_MAX = 4;

/** Core-line wobble amplitude — 0 since Rev 4 (the spine stays straight). */
export const WOBBLE_AMP = 0;
export const WOBBLE_FREQ = 0.045;

/** Y distance from the newest node down to the NOW convergence point. */
export const NOW_GAP = 7;
/** Span above NOW over which strand threads leave their lane and merge in. */
export const CONVERGE_SPAN = 5.5;

/** Bead size mapping: size = BASE_SIZE + SIZE_K * sqrt(turn_count). */
export const BEAD_BASE_SIZE = 0.11;
export const BEAD_SIZE_K = 0.05;
export const BEAD_MAX_SIZE = 0.28;

/** Brightness fades with Y distance from "now"; ancient nodes glow ember. */
export const FADE_FRACTION = 0.7;
export const EMBER_BRIGHTNESS = 0.22;

/** Strand lane cross-section: the cable bundle's disc radius range. */
export const STRAND_LANE_MIN = 1.0;
export const STRAND_LANE_MAX = 2.4;

// ─── Strand palette (§5.0, oklch — previously-site landing tokens) ─────────

export const STRAND_PALETTE = [
  "oklch(0.6 0.23 260)", // brand blue — time
  "oklch(0.7 0.12 85)", // amber
  "oklch(0.7 0.15 160)", // emerald
  "oklch(0.72 0.14 350)", // rose
  "oklch(0.68 0.16 300)", // violet
] as const;

/** Grey for strand-less events (§5.0). */
export const STRANDLESS_GREY = "oklch(0.556 0 0)";

// ─── Public types ──────────────────────────────────────────────────────────

export interface TimelineNodeLayout {
  id: string;
  /** Index into the nodes array (oldest → newest). */
  index: number;
  /** Position on the core line (wobble included). y decreases toward now. */
  position: [number, number, number];
  /** The node's Y coordinate (monotonic with time, decreasing). */
  y: number;
  /** Bead radius, ∝ sqrt(turn_count). */
  size: number;
  /** 0..1, fades with distance from the newest slice. */
  brightness: number;
  strands: string[];
  /** Catalog tags — the T1 card's neutral chips (Rev 3). */
  tags: string[];
  /** Turn count (catalog `turn_count`, defaults 1) — the card footer's ticks. */
  turnCount: number;
  /** Emotional tone, when marked — shown on tall cards. */
  tone?: string;
  /** Open loops / decisions — the tall tier's bullet lines (Rev 3). */
  openLoops: string[];
  decisions: string[];
  continuesFrom?: string;
  closedBy?: string;
  /** Catalog fields carried for the info layers (timestamps, cards). */
  start: string;
  /** UTC ISO 8601 end (absent while active) — the meta line's time range. */
  end?: string;
  /** Calendar date "YYYY-MM-DD" (from the catalog). */
  date: string;
  focus: string;
  summary: string;
  /** True for the first node of a calendar day — hosts the big date glyph. */
  dayStart: boolean;
}

export interface StrandLayout {
  name: string;
  /** CSS `oklch()` string from STRAND_PALETTE, deterministic per name. */
  color: string;
  /**
   * Lateral lane offset (x, z) — the strand's seat in the cable bundle's
   * cross-section. The strand arc curves pass through carrier nodes offset
   * by this lane (§R5.3).
   */
  offset: [number, number];
  /** Node indices carrying this strand, ascending. */
  carriers: number[];
}

export interface TimelineLayout {
  /** Oldest → newest, matching the catalog order. */
  nodes: TimelineNodeLayout[];
  /** One entry per strand that appears on ≥1 slice. */
  strands: StrandLayout[];
  /** Y of the oldest node (top of the timeline, the maximum y). */
  yTop: number;
  /** Y of the NOW convergence point (bottom, below the newest node). */
  nowY: number;
  /** NOW point position (on the core line, wobble included). */
  nowPosition: [number, number, number];
}

/** Zoom level semantics (doc/design §R5.1): level is a first-class state. */
export interface ZoomState {
  /** The target level: 0 Atlas · 1 Index · 2 Digest · 3 Detail · 4 Conversation. */
  level: ZoomLevel;
  /** The level's fixed camera distance from the core plane. */
  distance: number;
  /** L0+: big day-group labels. */
  dateMarkers: boolean;
  /** L1+: per-node small time labels. */
  timePoints: boolean;
  /** L3+: strand arcs weave through the carrier cards (§R5.3). */
  strandArcs: boolean;
  /** L1+: cards on the nodes near the camera (cardTier ≥ 1). */
  cards: boolean;
  /** Card content tier — 1:1 with the level (0 = no card). */
  cardTier: 0 | 1 | 2 | 3 | 4;
  /** L4: turn previews / the conversation layer. */
  turns: boolean;
}

// ─── Deterministic strand hashing ──────────────────────────────────────────

/** djb2 — small, stable, good enough for color/offset derivation. */
export function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Deterministic strand color: one of the five §5.0 oklch palette entries. */
export function strandColor(name: string): string {
  return STRAND_PALETTE[hashString(name) % STRAND_PALETTE.length];
}

/**
 * Deterministic lane offset for a strand — a point in the cable bundle's
 * cross-section disc, radius in [STRAND_LANE_MIN, STRAND_LANE_MAX]. x is the
 * in-plane lateral axis (visible head-on), z the depth axis (revealed by the
 * rotation gesture, §5.3).
 */
export function strandOffset(name: string): [number, number] {
  const h = hashString(name);
  const angle = (((h >>> 8) % 1000) / 1000) * Math.PI * 2;
  const t = ((h >>> 16) % 1000) / 1000;
  const radius = STRAND_LANE_MIN + t * (STRAND_LANE_MAX - STRAND_LANE_MIN);
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

/** The core line's horizontal offset at height y — currently a straight 0
 *  (WOBBLE_AMP = 0, Rev 4); the signature stays so a wobble can return
 *  without touching the call sites. */
export function coreXAt(y: number): number {
  return WOBBLE_AMP * Math.sin(y * WOBBLE_FREQ);
}

// ─── oklch → sRGB (three.js materials need rgb; DOM uses the oklch string) ──

/**
 * Convert a CSS `oklch(L C H)` string to a `#rrggbb` hex string. Pure math
 * (OKLCH → OKLab → linear sRGB → gamma), out-of-gamut channels are clamped.
 * Unknown formats are passed through unchanged.
 */
export function oklchToHex(color: string): string {
  const m = color.match(
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/,
  );
  if (!m) return color;
  const L = Number(m[1]);
  const C = Number(m[2]);
  const H = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const mi = m_ ** 3;
  const s = s_ ** 3;

  const toSrgb = (x: number): number => {
    const c = Math.min(1, Math.max(0, x));
    return Math.round(
      (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255,
    );
  };
  const r = toSrgb(+4.0767416621 * l - 3.3077115913 * mi + 0.2309699292 * s);
  const g = toSrgb(-1.2684380046 * l + 2.6097574011 * mi - 0.3413193965 * s);
  const bl = toSrgb(-0.0041960863 * l - 0.7034186147 * mi + 1.707614701 * s);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

// ─── Gap policy ────────────────────────────────────────────────────────────

const REAL_BOUNDARY = new Set(["idle_gap", "context_lost"]);

/**
 * True when the boundary BEFORE `next` should read as a long gap: the
 * predecessor closed on a real boundary (idle_gap / context_lost), or carries
 * no closed_by at all (legacy / migration data — §1.4 treats a missing
 * closed_by as a real boundary). Checkpoint-linked successors (time_cap /
 * capacity with a continues_from pointer) cluster instead.
 */
export function isRealBoundaryBefore(
  prev: TimelineSliceEntry,
  next: TimelineSliceEntry,
): boolean {
  if (next.continues_from && next.continues_from === prev.id) return false;
  if (!prev.closed_by) return true;
  return REAL_BOUNDARY.has(prev.closed_by);
}

function hoursBetween(a: string, b: string): number {
  const dt = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return dt / 3_600_000;
}

// ─── Layout computation ────────────────────────────────────────────────────

/**
 * Compute the full layout from the timeline catalog. Entries are sorted by
 * start time defensively (the catalog is already oldest → newest). The oldest
 * node sits at y=0 and every newer node sinks lower, so y is monotonically
 * DECREASING with time; NOW rests NOW_GAP below the newest node.
 * Returns `{ nodes: [], strands: [], yTop: 0, nowY: -NOW_GAP, ... }` for an
 * empty catalog.
 */
export function computeTimelineLayout(
  entries: TimelineSliceEntry[],
): TimelineLayout {
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start));
  if (sorted.length === 0) {
    return {
      nodes: [],
      strands: [],
      yTop: 0,
      nowY: -NOW_GAP,
      nowPosition: [coreXAt(-NOW_GAP), -NOW_GAP, 0],
    };
  }

  // Y: cumulative gaps downward. Time monotonicity guarantees y monotonicity.
  const ys: number[] = [0];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    const linked = next.continues_from === prev.id;
    const timeComponent = Math.min(
      hoursBetween(prev.start, next.start) * HOUR_SCALE,
      TIME_COMPONENT_MAX,
    );
    const gap = linked
      ? CLUSTER_GAP
      : isRealBoundaryBefore(prev, next)
        ? BOUNDARY_GAP + timeComponent
        : BASE_GAP + timeComponent;
    ys.push(ys[i - 1] - gap);
  }
  const yTop = 0;
  const yBottom = ys[ys.length - 1];
  const span = Math.max(-yBottom, 1);
  const fadeDistance = span * FADE_FRACTION;

  const nodes: TimelineNodeLayout[] = sorted.map((entry, i) => {
    const y = ys[i];
    const turns = entry.turn_count ?? 1;
    const size = Math.min(
      BEAD_BASE_SIZE + BEAD_SIZE_K * Math.sqrt(turns),
      BEAD_MAX_SIZE,
    );
    // Newest node is brightest; the past fades toward ember.
    const brightness =
      EMBER_BRIGHTNESS +
      (1 - EMBER_BRIGHTNESS) * Math.max(0, 1 - (y - yBottom) / fadeDistance);
    return {
      id: entry.id,
      index: i,
      position: [coreXAt(y), y, 0],
      y,
      size,
      brightness,
      strands: entry.strands ?? [],
      tags: entry.tags ?? [],
      turnCount: turns,
      tone: entry.tone,
      openLoops: entry.open_loops ?? [],
      decisions: entry.decisions ?? [],
      continuesFrom: entry.continues_from,
      closedBy: entry.closed_by,
      start: entry.start,
      end: entry.end,
      date: entry.date,
      focus: entry.focus,
      summary: entry.summary,
      dayStart: i === 0 || sorted[i - 1].date !== entry.date,
    };
  });

  // Strands: collect carrier node indices per strand name. O(total
  // strand incidences) — no pairwise work, safe at 200 strands × 500 nodes.
  const carrierMap = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    for (const name of node.strands) {
      const list = carrierMap.get(name);
      if (list) list.push(i);
      else carrierMap.set(name, [i]);
    }
  });
  const strands: StrandLayout[] = [...carrierMap.entries()].map(
    ([name, carriers]) => ({
      name,
      color: strandColor(name),
      offset: strandOffset(name),
      carriers,
    }),
  );

  const nowY = yBottom - NOW_GAP;
  return {
    nodes,
    strands,
    yTop,
    nowY,
    nowPosition: [coreXAt(nowY), nowY, 0],
  };
}

// ─── Zoom levels (§R5.1: level is a first-class state) ─────────────────────

/**
 * Discrete zoom levels. The zoom gesture STEPS between levels instead of
 * driving a continuous distance: the camera eases to the level's fixed
 * distance while the content switches to the target level in the same frame
 * (CSS transitions absorb the jump) — no threshold flapping, no hysteresis.
 */
export type ZoomLevel = 0 | 1 | 2 | 3 | 4;
export const MAX_ZOOM_LEVEL: ZoomLevel = 4;
/** Fixed camera distance per level (L0 Atlas → L4 Conversation). */
export const LEVEL_DISTANCES: readonly number[] = [56, 40, 28, 19, 13];

/**
 * Map a zoom level to the scene's information-density state. Pure: the
 * gesture rig owns the level, everything visual derives from this.
 */
export function zoomStateForLevel(level: ZoomLevel): ZoomState {
  return {
    level,
    distance: LEVEL_DISTANCES[level],
    dateMarkers: true,
    timePoints: level >= 1,
    strandArcs: level >= 3,
    cards: level >= 1,
    cardTier: level,
    turns: level >= 4,
  };
}
