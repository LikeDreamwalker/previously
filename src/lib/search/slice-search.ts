/**
 * Shared slice-catalog search — the single retrieval implementation for both
 * the user-facing command palette and the recall sub-agent (v0.10 §3.1: agent
 * side and user side search through the SAME functions).
 *
 * Pure functions only — no I/O. Callers feed `TimelineSliceEntry[]` in (from
 * `readTimelineIndex`) and get scored hits out. First iteration searches
 * catalog metadata only (focus/summary/tags/open_loops/decisions/strands);
 * cross-slice full-text search is a later candidate.
 */

import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

/** Catalog fields the keyword query runs against. */
export type SearchableField =
  | "tags"
  | "focus"
  | "summary"
  | "open_loops"
  | "decisions"
  | "strands";

/** Field weights — tags > focus > summary > open_loops/decisions > strands. */
const FIELD_WEIGHTS: Record<SearchableField, number> = {
  tags: 5,
  focus: 4,
  summary: 3,
  open_loops: 2,
  decisions: 2,
  strands: 1,
};

/** Canonical display order for matchedFields (highest weight first). */
const FIELD_ORDER: SearchableField[] = [
  "tags",
  "focus",
  "summary",
  "open_loops",
  "decisions",
  "strands",
];

/** Snippets kept per field — enough for UI highlight, bounded payload. */
const MAX_SNIPPETS_PER_FIELD = 3;

/** Context radius around a match inside a long string field (summary). */
const SNIPPET_RADIUS = 40;

/** The matched fragments of one field, for UI highlighting. */
export interface FieldMatch {
  field: SearchableField;
  /** Matched text fragments — whole items for array fields (tags etc.),
   *  windowed excerpts for long string fields. */
  snippets: string[];
}

export interface SearchHit {
  entry: TimelineSliceEntry;
  /** Weighted score: sum over fields of weight × hit count. 0 for
   *  strand-only queries (pure filter, no keyword). */
  score: number;
  /** Fields with at least one match, in weight order. */
  matchedFields: SearchableField[];
  /** Per-field matched fragments. */
  matches: FieldMatch[];
}

/**
 * Filter the catalog to an inclusive YYYY-MM-DD date window — the same
 * semantics as recall's readTimelineWindow: the slice id's first 10 chars
 * (its UTC date) are compared lexicographically; either bound may be omitted.
 * Input order is preserved.
 */
export function filterByWindow(
  entries: TimelineSliceEntry[],
  from?: string,
  to?: string,
): TimelineSliceEntry[] {
  return entries.filter((s) => {
    const date = s.id.slice(0, 10); // "YYYY-MM-DD"
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });
}

/**
 * Filter the catalog to slices carrying a strand (case-insensitive — the
 * name may be typed by hand in the `#strand` query syntax).
 */
export function filterByStrand(
  entries: TimelineSliceEntry[],
  strand: string,
): TimelineSliceEntry[] {
  const needle = strand.trim().toLowerCase();
  if (!needle) return [];
  return entries.filter((s) =>
    s.strands.some((t) => t.toLowerCase() === needle),
  );
}

/**
 * Newest-first ordering by slice id (the id's UTC timestamp sorts
 * lexicographically). The one canonical ordering shared by searchCatalog's
 * strand-only path AND the recall sub-agent's timeline pagination (v0.10 §3.1).
 */
export function sortNewestFirst(
  entries: readonly TimelineSliceEntry[],
): TimelineSliceEntry[] {
  return [...entries].sort((a, b) => b.id.localeCompare(a.id));
}

/** The keyword half of a query — `#strand` tokens stripped. The command
 *  palette uses this to highlight matches inside snippets. */
export function queryKeyword(query: string): string {
  return parseQuery(query).keyword;
}

/** Parsed query: `#name` tokens become strand filters, the rest is the
 *  keyword substring. */
function parseQuery(query: string): { keyword: string; strands: string[] } {
  const strands: string[] = [];
  const rest: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    if (token.startsWith("#")) {
      const name = token.slice(1);
      if (name) strands.push(name); // a bare "#" is ignored, not a keyword
    } else {
      rest.push(token);
    }
  }
  return { keyword: rest.join(" "), strands };
}

/** All case-insensitive occurrences of `needle` in `text` (start indices). */
function occurrences(text: string, needle: string): number[] {
  const hay = text.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Windowed excerpts around each occurrence of `needle` in a long string. */
function stringSnippets(text: string, needle: string): string[] {
  return occurrences(text, needle)
    .slice(0, MAX_SNIPPETS_PER_FIELD)
    .map((i) => {
      const start = Math.max(0, i - SNIPPET_RADIUS);
      const end = Math.min(text.length, i + needle.length + SNIPPET_RADIUS);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < text.length ? "…" : "";
      return `${prefix}${text.slice(start, end)}${suffix}`;
    });
}

/** Score one string field; returns null on no match. */
function matchString(
  text: string,
  keyword: string,
): { count: number; snippets: string[] } | null {
  const hits = occurrences(text, keyword);
  if (hits.length === 0) return null;
  return { count: hits.length, snippets: stringSnippets(text, keyword) };
}

/** Score one array field; matching items are the snippets. */
function matchArray(
  items: string[],
  keyword: string,
): { count: number; snippets: string[] } | null {
  const matched = items.filter((it) => it.toLowerCase().includes(keyword));
  if (matched.length === 0) return null;
  return {
    count: matched.length,
    snippets: matched.slice(0, MAX_SNIPPETS_PER_FIELD),
  };
}

/**
 * Search the catalog by keyword (case-insensitive substring over
 * focus/summary/tags/open_loops/decisions/strands), with `#strand` tokens in
 * the query applied as strand filters first.
 *
 * Scoring: per field, weight × hit count (occurrences in string fields,
 * matching items in array fields); summed across fields. Hits sort by score
 * descending, ties broken newest-first by id. A query of only `#strand`
 * tokens is a pure filter — those hits carry score 0 and sort newest-first.
 * An empty query (no keyword, no strands) returns [].
 */
export function searchCatalog(
  entries: TimelineSliceEntry[],
  query: string,
): SearchHit[] {
  const { keyword, strands } = parseQuery(query);
  const needle = keyword.trim().toLowerCase();
  if (!needle && strands.length === 0) return [];

  let pool = entries;
  for (const strand of strands) {
    pool = filterByStrand(pool, strand);
  }

  if (!needle) {
    // Strand-only query: pure filter, no scoring — newest first.
    return sortNewestFirst(pool).map((entry) => ({
      entry,
      score: 0,
      matchedFields: ["strands"] as SearchableField[],
      matches: [
        {
          field: "strands" as SearchableField,
          snippets: entry.strands.filter((t) =>
            strands.some((s) => t.toLowerCase() === s.toLowerCase()),
          ),
        },
      ],
    }));
  }

  const hits: SearchHit[] = [];
  for (const entry of pool) {
    const matches: FieldMatch[] = [];
    let score = 0;

    const fields: Array<[SearchableField, string | string[]]> = [
      ["tags", entry.tags],
      ["focus", entry.focus],
      ["summary", entry.summary],
      ["open_loops", entry.open_loops],
      ["decisions", entry.decisions],
      ["strands", entry.strands],
    ];
    for (const [field, value] of fields) {
      const result = Array.isArray(value)
        ? matchArray(value, needle)
        : matchString(value, needle);
      if (result) {
        score += FIELD_WEIGHTS[field] * result.count;
        matches.push({ field, snippets: result.snippets });
      }
    }

    if (score > 0) {
      hits.push({
        entry,
        score,
        matchedFields: matches.map((m) => m.field),
        matches,
      });
    }
  }

  return hits.sort(
    (a, b) => b.score - a.score || b.entry.id.localeCompare(a.entry.id),
  );
}
