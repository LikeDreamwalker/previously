/**
 * Stack rows for the Rev 8 timeline (doc/design/v0.10.0 §R8) — pure
 * functions, no React/R3F.
 *
 * The right field is a vertical DOM list whose ROW GRANULARITY is the zoom
 * level: L0 one slice per row, L1 one day-stack per row, L2 one month-stack
 * per row. A stack is a visual fiction — the top card is real, the depth is
 * 0-3 hash-posed shells plus a count badge, so a 700-slice month costs the
 * same as a 2-slice day.
 *
 * Row order follows the catalog: oldest at the top, newest at the bottom
 * (same reading direction as the chat stream; the list bottom-anchors).
 */
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { hashString } from "./layout";

/** Zoom levels: 0 = slice rows · 1 = day stacks · 2 = month stacks. */
export type StackLevel = 0 | 1 | 2;

export const STACK_LEVELS: StackLevel[] = [0, 1, 2];
/** Landing level (§R8): day stacks — overview with a readable top card. */
export const DEFAULT_LEVEL: StackLevel = 1;

export interface StackRow {
  /** Stable key: the slice id (L0), "d:YYYY-MM-DD" (L1), "m:YYYY-MM" (L2). */
  key: string;
  level: StackLevel;
  /** Newest entry of the group — its content heads the stack. */
  top: TimelineSliceEntry;
  /** Slices in the group (always 1 at L0). */
  count: number;
  /** Group members, oldest → newest. */
  entries: TimelineSliceEntry[];
  /** Union of member strands, first-seen order (stack accent dots). */
  strands: string[];
}

/** The row key a given entry falls into at a level. */
export function rowKeyFor(entry: TimelineSliceEntry, level: StackLevel): string {
  if (level === 0) return entry.id;
  if (level === 1) return `d:${entry.date}`;
  return `m:${entry.date.slice(0, 7)}`;
}

/**
 * Partition the catalog window into rows for a level. Entries are sorted by
 * start defensively; groups inherit first-seen order so rows stay strictly
 * chronological.
 */
export function groupForLevel(
  entries: TimelineSliceEntry[],
  level: StackLevel,
): StackRow[] {
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start));
  const byKey = new Map<string, TimelineSliceEntry[]>();
  for (const e of sorted) {
    const key = rowKeyFor(e, level);
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const rows: StackRow[] = [];
  for (const [key, members] of byKey) {
    const strands: string[] = [];
    for (const e of members) {
      for (const s of e.strands) if (!strands.includes(s)) strands.push(s);
    }
    rows.push({
      key,
      level,
      top: members[members.length - 1],
      count: members.length,
      entries: members,
      strands,
    });
  }
  return rows;
}

// ─── Card geometry (Rev 9: the card is a fixed-size playing card) ───────────

/**
 * The card face is a FIXED-SIZE playing card (§R9.1): same face at every
 * zoom level, in a few responsive width tiers (JS-side, because the 3D pile
 * field needs the same numbers — CSS-only breakpoints can't feed WebGL).
 * Rows are fixed-pitch too, so every row's screen rect is a pure function of
 * (rowIndex, scrollTop) — the pile canvas never measures the DOM.
 */
export interface CardGeometry {
  /** Card face px. */
  cardW: number;
  cardH: number;
  /** Gap below an L0 slice row's card. */
  gapSlice: number;
  /** Room below a stack row's card reserved for the 3D pile peek. */
  gapStack: number;
}

/** Card aspect — a landscape playing card (~1.76:1). */
export const CARD_RATIO = 1.76;

export function cardGeometryFor(viewportW: number): CardGeometry {
  const cardW =
    viewportW < 480
      ? Math.round(Math.min(Math.max(viewportW - 88, 260), 330))
      : viewportW < 1024
        ? 340
        : 380;
  return {
    cardW,
    cardH: Math.round(cardW / CARD_RATIO),
    gapSlice: 16,
    gapStack: 44,
  };
}

/** Row pitch (px) for a level under a geometry — the DOM row height AND the
 *  pile-field row spacing; both sides must read this one source. */
export function rowPitchFor(level: StackLevel, geo: CardGeometry): number {
  return geo.cardH + (level === 0 ? geo.gapSlice : geo.gapStack);
}

// ─── Frame geometry (Rev 10: the card is a big film frame) ──────────────────

/**
 * The R3F card field's geometry: one card is a big PORTRAIT frame — roughly
 * 70% of the field height, wide but never edge-to-edge, so a screen holds
 * ~1.3 cards. Pure function of the field's pixel size; the scene never
 * measures the DOM.
 */
export interface FrameGeometry {
  /** Card face px. */
  cardW: number;
  cardH: number;
  /** Vertical pitch between row anchors (px). */
  pitch: number;
}

/** Portrait aspect (W/H) of the frame card for narrow fields. */
export const FRAME_RATIO = 0.8;

/** Landscape aspect (W/H) of the frame card for wide desktop fields. */
export const FRAME_LANDSCAPE_RATIO = 1.5;

export function frameGeometryFor(fieldW: number, fieldH: number): FrameGeometry {
  // Wide desktop field: a landscape dossier card, ~78% of the field width,
  // capped at 900px, with its height capped to ~82% of the field height.
  if (fieldW >= 900) {
    let cardW = Math.round(Math.min(fieldW * 0.78, 900));
    let cardH = Math.round(Math.min(cardW / FRAME_LANDSCAPE_RATIO, fieldH * 0.82));
    if (cardH < 300) {
      cardH = 300;
      cardW = Math.round(cardH * FRAME_LANDSCAPE_RATIO);
    }
    return { cardW, cardH, pitch: Math.round(cardH * 1.12) };
  }

  // Narrow field: keep the original portrait frame logic.
  const cardH = Math.round(Math.min(Math.max(fieldH * 0.7, 300), 720));
  const cardW = Math.round(
    Math.min(cardH * FRAME_RATIO, Math.max(fieldW - 40, 240), 600),
  );
  return { cardW, cardH, pitch: Math.round(cardH * 1.12) };
}

/** Row pitch per level: slice rows pack tight; stack levels leave a wide
 *  gap below the card so the backing-sheet pile has room to peek out. */
export function framePitchFor(level: StackLevel, geo: FrameGeometry): number {
  return Math.round(geo.cardH * (level === 0 ? 1.06 : 1.24));
}

/**
 * Backing sheets under a stack's top card (Rev 10, user-specified tiers):
 * small piles show their REAL count (2–3 cards), mid piles always read as
 * five, big piles read as seven with the deepest sheets faded — the exact
 * count is never judged per render, only bucketed.
 */
export function backingSheets(count: number): number {
  if (count <= 1) return 0;
  if (count <= 3) return count - 1;
  if (count <= 8) return 4;
  return 6;
}

/** Scale the hash-stable shell/sheet poses (authored against the old 216px
 *  card) up to the frame card's size. */
export function poseScaleFor(geo: FrameGeometry): number {
  return geo.cardH / 216;
}

// ─── Stack shell pose (the "一沓" look) ─────────────────────────────────────

/** Shell layers behind the top card, by group size. */
export const MAX_SHELLS = 3;

/** 1 slice → no shells (a plain card); 2-4 → 1; 5-12 → 2; 13+ → 3. */
export function densityTier(count: number): 0 | 1 | 2 | 3 {
  if (count <= 1) return 0;
  if (count <= 4) return 1;
  if (count <= 12) return 2;
  return 3;
}

export interface ShellPose {
  /** Degrees, ±(0.5°–1.4°) — DOM rows are wide; big tilts look broken. */
  rotate: number;
  /** px, ±(3–8) — the shell's edge peeks out on one side. */
  offsetX: number;
  /** px, +(3–7) — shells peek out BELOW the top card. */
  offsetY: number;
}

/**
 * Hash-stable pose for shell `i` of a group — re-renders never reshuffle the
 * pile. Deeper shells drift further down and to their side. The pile reads
 * through edge offsets, not rotation: a wide DOM card rotated even 3° swings
 * its corners tens of px, which reads as broken, not askew.
 *
 * Rev 9: this is the NO-WEBGL FALLBACK only — with WebGL the pile is real
 * 3D sheets (`sheetPose` below, rendered by pile-field.tsx).
 */
export function shellPose(groupKey: string, i: number): ShellPose {
  const h = hashString(`${groupKey}#${i}`);
  const u = ((h >>> 3) % 1000) / 1000;
  const v = ((h >>> 13) % 1000) / 1000;
  const w = ((h >>> 23) % 512) / 512;
  const sign = h & 1 ? 1 : -1;
  return {
    rotate: sign * (0.5 + u * 0.9),
    offsetX: sign * (3 + v * 5) * (1 + i * 0.4),
    offsetY: (3 + w * 4) * (1 + i * 0.5),
  };
}

export interface SheetPose {
  /** Degrees — cumulative fan tilt, opposite sign of offsetX (a card that
   *  slipped down-right rotates with its right side lower). */
  rotate: number;
  /** px — cumulative lateral cascade, stable sign per pile. */
  offsetX: number;
  /** px — cumulative downward cascade (always positive). */
  offsetY: number;
}

/**
 * Hash-stable pose for 3D sheet `i` of a pile (pile-field.tsx). A real deck
 * placed by hand CASCADES — each sheet slips a little further in one stable
 * direction — so the pose is cumulative in `i` (sheet 0 peeks least) with a
 * per-pile direction/step drawn from the group hash, plus small per-sheet
 * jitter. Fits inside `gapStack` (max |offsetY| ≈ 14px < 44px).
 */
export function sheetPose(groupKey: string, i: number): SheetPose {
  const pile = hashString(`s3d:${groupKey}`);
  const sign = pile & 1 ? 1 : -1;
  const step = 4.5 + (((pile >>> 5) % 1000) / 1000) * 3; // 4.5–7.5px per sheet
  const fan = 0.7 + (((pile >>> 15) % 1000) / 1000) * 0.9; // 0.7–1.6° per sheet
  const j = ((hashString(`s3d:${groupKey}#${i}`) >>> 5) % 1000) / 1000 - 0.5;
  const n = i + 1;
  return {
    rotate: -sign * fan * n + j * 0.6,
    offsetX: sign * step * n * 0.7 + j * 3,
    offsetY: step * n * 0.55 + Math.abs(j) * 2.5,
  };
}

// ─── Re-anchor across level / filter / paging changes ───────────────────────

/**
 * Find the row containing an anchor entry (the first visible row's top card
 * before the change). Exact containment first; when the entry left the window
 * (a strand filter can remove it), fall back to the nearest row by start time
 * so the list still lands somewhere sensible.
 */
export function indexForAnchor(rows: StackRow[], anchorId: string): number {
  const exact = rows.findIndex(
    (r) => r.top.id === anchorId || r.entries.some((e) => e.id === anchorId),
  );
  if (exact >= 0) return exact;
  if (rows.length === 0) return -1;
  // The anchor id starts with its date — lexical compare works on the id.
  let best = 0;
  let bestDist = Infinity;
  const anchorMs = anchorStartMs(anchorId);
  rows.forEach((r, i) => {
    const d = Math.abs(new Date(r.top.start).getTime() - anchorMs);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** Anchor ids are slice ids ("YYYY-MM-DD-HHMM") — parse, else epoch. */
function anchorStartMs(anchorId: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/.exec(anchorId);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Filter the catalog to a strand's carriers (null = 核心时间线, no filter). */
export function filterByStrand(
  entries: TimelineSliceEntry[],
  strand: string | null,
): TimelineSliceEntry[] {
  if (!strand) return entries;
  return entries.filter((e) => e.strands.includes(strand));
}
