/**
 * Left time rail geometry (v0.10 §1.3 Rev 2) — pure, no React/DOM.
 *
 * The stream component measures the rendered turn items (Virtuoso tags every
 * item wrapper with `data-index`, so rects map back to stream items) and feeds
 * their viewport-relative rects here; this maps them to rail node positions.
 * The rail is turn-granular and PURELY presentational — slice-level jumps are
 * the timeline mode's job (§1.3 职责边界).
 */

export interface RailNodeInput {
  /** Stable key — the stream item's key. */
  key: string;
  /** The turn's timestamp (ISO). Empty/invalid timestamps are dropped. */
  timeIso: string;
  /** Item rect top relative to the scroller viewport's top (px; may be
   *  negative when the item straddles the top edge). */
  top: number;
  /** Item rect height (px). */
  height: number;
}

export interface RailNode {
  key: string;
  timeIso: string;
  /** Node center on the rail, px from the viewport top, clamped inside. */
  y: number;
}

/** Node labels never sit closer than this — a closer one collapses (the one
 *  above wins). */
export const RAIL_MIN_GAP_PX = 28;
/** Nodes never sit closer than this to the rail's ends. */
export const RAIL_EDGE_PAD_PX = 10;

/**
 * Map the visible turn items to rail nodes:
 * - items not intersecting the viewport anchor nothing;
 * - a straddling item's node clamps to the nearest padded edge;
 * - nodes keep `minGap` px between each other (top-most of a cluster wins).
 */
export function computeRailNodes(
  inputs: readonly RailNodeInput[],
  viewportHeight: number,
  minGap: number = RAIL_MIN_GAP_PX,
  edgePad: number = RAIL_EDGE_PAD_PX,
): RailNode[] {
  if (viewportHeight <= edgePad * 2) return [];
  const nodes: RailNode[] = [];
  for (const input of inputs) {
    if (!input.timeIso || Number.isNaN(Date.parse(input.timeIso))) continue;
    if (input.top + input.height <= 0 || input.top >= viewportHeight) continue;
    const y = Math.min(Math.max(input.top, edgePad), viewportHeight - edgePad);
    nodes.push({ key: input.key, timeIso: input.timeIso, y });
  }
  nodes.sort((a, b) => a.y - b.y);
  const spaced: RailNode[] = [];
  for (const node of nodes) {
    const last = spaced[spaced.length - 1];
    if (last && node.y - last.y < minGap) continue;
    spaced.push(node);
  }
  return spaced;
}
