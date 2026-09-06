/**
 * Catalog pagination (Rev 7 §R7.4) — pure month-window slicing of the
 * timeline catalog. The canonical index stays a single file on disk; the
 * window exists so the CLIENT never holds/computes more history than the
 * viewport can reach: the page loads the latest N months, and scrolling
 * toward the oldest loaded entry prefetches the previous window (infinite
 * scroll's old trade, now upward).
 */
import type { TimelineSliceEntry } from "./types";

export interface CatalogPage {
  /** Oldest → newest, ready to prepend/append into the client catalog. */
  entries: TimelineSliceEntry[];
  /** Month key (YYYY-MM) of the oldest entry in this page — the next
   *  call's `before`. Null when the page is empty. */
  oldestMonth: string | null;
  /** True when entries older than this page exist. */
  hasMore: boolean;
}

/**
 * Take the newest `months` distinct months of the catalog, optionally only
 * those strictly older than `before` (a month key from a previous page —
 * exclusive, so pages never overlap). Entries sort defensively by start.
 */
export function pageCatalog(
  all: TimelineSliceEntry[],
  before: string | null,
  months: number,
): CatalogPage {
  const sorted = [...all].sort((a, b) => a.start.localeCompare(b.start));
  const eligible = before
    ? sorted.filter((e) => e.date.slice(0, 7) < before)
    : sorted;

  const seen = new Set<string>();
  const picked: TimelineSliceEntry[] = [];
  let hasMore = false;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const e = eligible[i];
    const m = e.date.slice(0, 7);
    if (!seen.has(m) && seen.size >= months) {
      hasMore = true;
      break;
    }
    seen.add(m);
    picked.push(e);
  }
  picked.reverse();

  return {
    entries: picked,
    oldestMonth: picked.length > 0 ? picked[0].date.slice(0, 7) : null,
    hasMore,
  };
}
