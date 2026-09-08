/**
 * Pile scene math (Rev 9 §R9.2) — pure functions/constants for the R3F pile
 * field, no three.js imports so it stays unit-testable. Rendering lives in
 * `src/components/timeline-3d/pile-field.tsx`.
 *
 * The pile under a stack card is a small deck of thin sheets: the DOM top
 * card occludes the top sheet, lower sheets peek out below/side via
 * hash-stable poses (`sheetPose` from stacks.ts) plus a slight forward tilt
 * that exposes the sheets' bottom edges (thickness = the 3D tell).
 */
import { densityTier, type StackRow } from "./stacks";

export interface PileSpec {
  /** The StackRow key — also the hover/deal-animation identity. */
  key: string;
  /** Index in the rows array (screen position derives from it). */
  rowIndex: number;
  /** Rendered sheets (1-3), from `densityTier`. */
  sheets: number;
}

/** Piles for the current rows: stacks (L1/L2) with more than one slice. */
export function pileSpecsFor(rows: StackRow[]): PileSpec[] {
  const specs: PileSpec[] = [];
  rows.forEach((r, i) => {
    if (r.level === 0) return;
    const sheets = densityTier(r.count);
    if (sheets > 0) specs.push({ key: r.key, rowIndex: i, sheets });
  });
  return specs;
}

// ─── Camera / world scale ───────────────────────────────────────────────────

export const PILE_FOV_DEG = 26;
/** Camera sits slightly above the view center, looking at the origin — the
 *  mild downward tilt is what makes scrolling read as parallax. */
export const PILE_CAM_Y = 1.05;
export const PILE_CAM_Z = 8.4;

/** Sheet thickness and the gap between sheets, world units. */
export const SHEET_THICK = 0.016;
export const SHEET_GAP = 0.02;
/** Lean-back tilt per sheet (radians, negative = top edge recedes): the face
 *  normal turns UP toward the key light so the sheet faces read bright, and
 *  the bottom edge tips toward the viewer, exposing the sheet's thickness
 *  below the DOM card. */
export const SHEET_TILT_X = -0.12;
/** Extra tilt per depth step, so deeper sheets fan a little more. */
export const SHEET_TILT_STEP = -0.035;
/** Max scroll-rocking rotation (radians) at the pile level. */
export const ROCK_MAX = 0.055;

/** World units per CSS px at the z=0 plane, along the view axis. */
export function worldPerPx(viewportH: number): number {
  const dist = Math.hypot(PILE_CAM_Y, PILE_CAM_Z);
  return (2 * dist * Math.tan((PILE_FOV_DEG * Math.PI) / 360)) / viewportH;
}

// ─── Deal / settle animation ────────────────────────────────────────────────

/** Seconds for one pile's deal-in. */
export const DEAL_DURATION = 0.55;
/** Stagger between piles in a deal, seconds per viewport-row of distance. */
export const DEAL_STAGGER = 0.06;

/**
 * Deal progress → eased settle factor (0 = airborne above, 1 = settled).
 * smoothstep — a spring would be prettier but this runs per-sheet per-frame
 * with zero allocation.
 */
export function settleEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
