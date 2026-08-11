/**
 * Global Timeline Index — a single file with summaries of all closed slices.
 *
 * Replaces the old `readRecentSummaries` which scanned monthly _index.json
 * files. The global timeline is one flat markdown file at
 * memory/episodic/timeline.md that the recall agent reads as its starting
 * point. Updated on slice close.
 */

import { weaveTimeline, readTimelineMd } from "../timeline/weave";

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Rebuild the global timeline via the v0.8 projection (`weaveTimeline`).
 * Throttled — the full reconcile runs when the catalog is stale or on close;
 * otherwise it returns the cached projection. Kept as the accessor all callers
 * (housekeeping, finalize, recall) already use.
 */
export async function generateGlobalTimeline(): Promise<string> {
  await weaveTimeline();
  return readTimelineMd();
}

/**
 * Legacy append API — now a forced reconcile so a just-closed slice is
 * visible immediately. (Kept for callers; the slice-close path in housekeeping
 * calls `weaveTimeline({ force: true })` directly.)
 */
export async function updateGlobalTimeline(): Promise<void> {
  await weaveTimeline({ force: true });
}
