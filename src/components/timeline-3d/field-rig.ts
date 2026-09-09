import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

/**
 * field-rig.ts — shared mutable scroll/animation rig types for the 3D card
 * field.
 *
 * Pulled out of card-field.tsx so that `RowGroup` and `LeavingCard` can import
 * the rig without creating a circular dependency on the main container.
 */

export interface DealOrigin {
  /** World-y offset from the new slot to the old slot (added to yWorld). */
  dy: number;
  /** World-z start offset (cards fly in from slightly behind). */
  dz: number;
}

/** Shared mutable scroll/animation rig — read by every row each frame. */
export interface FieldRig {
  target: number;
  current: number;
  /** Row index the last level change anchored on (deal origin). */
  anchorIndex: number;
  /** Timestamp of the last generation (level/filter/mount). */
  genAt: number;
  hoverKey: string | null;
  /** Per-new-row world offset from old slot to new slot. */
  dealOrigins: Map<string, DealOrigin> | null;
  /** Row keys eligible to play the deal-in animation on this generation. */
  dealEligible: Set<string> | null;
}

/** A slice that got swallowed by a coarser stack during a level transition. */
export interface LeavingItem {
  id: string;
  slice: TimelineSliceEntry;
  /** Old slot center in content px at transition start. */
  fromYpx: number;
  /** New row key the slice belongs to. */
  toRowKey: string;
  /** Index of the slice inside the new row's entries. */
  depth: number;
}
