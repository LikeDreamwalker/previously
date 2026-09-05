/**
 * Slice-seam classification (v0.10 design §1.4).
 *
 * The seam between two slices is driven by how the OLDER one closed
 * (`closed_by` in the timeline catalog):
 * - `time_cap` / `capacity` are periodic autosave CHECKPOINTS of one ongoing
 *   conversation (the follow-up slice links back via `continues_from`) — the
 *   seam is a whisper: a hairline + "auto-archived · conversation continues".
 * - `idle_gap` / `context_lost` / anything else / nothing (the oldest slice,
 *   migrated data) is a genuine conversation boundary — a strong divider with
 *   a date heading, doubling as a time bookmark.
 */

export type SeamKind = "checkpoint" | "boundary";

export function classifySeam(closedBy: string | null | undefined): SeamKind {
  return closedBy === "time_cap" || closedBy === "capacity"
    ? "checkpoint"
    : "boundary";
}
