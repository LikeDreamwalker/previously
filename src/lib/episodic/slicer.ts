/**
 * Slicing Decision Engine — pure time-based (v0.9).
 *
 * Three signals, checked in the chat route:
 * 1. Slice age — force-close once the slice has been open for
 *    `maxSliceMinutes` (measured from the slice start, not last activity).
 * 2. Turn count cap — pure safety net (`"capacity"`).
 * 3. Context loss — client history no longer matches the slice
 *    (`"context_lost"`, checked in steps.ts).
 *
 * Thresholds are read from the user config at request time so they can
 * be adjusted in Settings without a redeploy.
 */

// ─── Configurable defaults (overridable via memory/user/config.json) ───

export const DEFAULT_MAX_SLICE_AGE_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_MAX_TURNS_PER_SLICE = 50;

/**
 * Check whether the slice has been open long enough (wall-clock time since
 * its start) to warrant closing it.
 */
export function checkSliceAge(startIso: string, maxMs = DEFAULT_MAX_SLICE_AGE_MS): boolean {
  const elapsedMs = Date.now() - new Date(startIso).getTime();
  return elapsedMs >= maxMs;
}
