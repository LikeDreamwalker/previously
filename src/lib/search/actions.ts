"use server";

import { readTimelineIndex } from "@/lib/episodic/timeline/store";
import {
  filterByWindow,
  searchCatalog,
  type SearchHit,
} from "./slice-search";

/**
 * Search the slice catalog for the user-facing command palette (v0.10 §3.2).
 * Reads the same canonical catalog as getTimelineCatalog — the demo persona /
 * MEMORY_ROOT dual-datasource behavior lives in the shared fs layer
 * (`readTimelineIndex` → `fsReadFile`), so no persona handling is needed here.
 *
 * Query supports the `#strand` filter syntax; `from`/`to` bound the search to
 * an inclusive YYYY-MM-DD window before scoring. Returns scored hits (empty
 * array when the catalog isn't built yet or nothing matches).
 */
export async function searchSlices(
  query: string,
  opts?: { from?: string; to?: string },
): Promise<SearchHit[]> {
  const idx = await readTimelineIndex();
  const entries = idx?.slices ?? [];
  const windowed = filterByWindow(entries, opts?.from, opts?.to);
  return searchCatalog(windowed, query);
}
