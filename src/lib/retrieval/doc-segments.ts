/**
 * Document Segment Read — the shared partial-read protocol for all "read"
 * tools (readSlice for time slices, webFetch for web pages).
 *
 * Any document is a flat string the main agent may want to read selectively:
 * - by keyword search (return matched segments + context; if nothing matches,
 *   degrade to the full document with an explanatory note), or
 * - by line range (like reading a code file).
 *
 * Pure functions only — no I/O. The executors feed raw text in and get a
 * ready-to-return string out.
 */

/** A region of a document matched by keyword search. */
export interface SearchHit {
  /** 0-based index of the first segment that matched. */
  index: number;
  /** The matched segment + surrounding context, joined with "\n". */
  content: string;
  /** Which keywords triggered this hit (as provided). */
  keywords: string[];
}

/** Split a raw text into numbered segments for search. */
export type Segmenter = (text: string) => string[];

/**
 * Split a time-slice core.md into turn segments — one entry per turn header,
 * prefixed with its ordinal so hits are traceable back to the slice.
 */
export const splitTurns: Segmenter = (text: string) =>
  text
    .split(/(?=^## Turn )/m)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);

/**
 * Split arbitrary web text into paragraph segments on blank lines. Each
 * segment is one readable paragraph (or the whole text if no blank lines).
 */
export const splitParagraphs: Segmenter = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);

/**
 * Keyword search over segmented text. Case-insensitive substring match per
 * segment; each hit carries `contextBefore` segments before and `contextAfter`
 * after the matching segment. Deduplicates overlapping hits and sorts by
 * segment index. Returns [] when nothing matches.
 */
export function segmentSearch(
  segments: string[],
  keywords: string[],
  contextBefore = 1,
  contextAfter = 1,
): SearchHit[] {
  const lowered = keywords.filter((k) => k.trim().length > 0).map((k) => k.toLowerCase());
  if (lowered.length === 0 || segments.length === 0) return [];

  const matchedIndices = new Set<number>();
  const hitKeywords = new Map<number, string[]>();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].toLowerCase();
    const hit = lowered.filter((k) => seg.includes(k));
    if (hit.length > 0) {
      matchedIndices.add(i);
      hitKeywords.set(i, hit);
    }
  }

  // Dedupe hits whose windows overlap: walk matches in order, keep only the
  // first of any cluster that overlaps.
  const sorted = [...matchedIndices].sort((a, b) => a - b);
  const kept: number[] = [];
  let lastEnd = -1;
  for (const idx of sorted) {
    const end = idx + contextAfter;
    if (kept.length === 0 || idx > lastEnd) {
      kept.push(idx);
      lastEnd = end;
    } else {
      // Overlapping window — merge into the kept hit.
      lastEnd = Math.max(lastEnd, end);
    }
  }

  return kept.map((idx) => {
    const start = Math.max(0, idx - contextBefore);
    const end = Math.min(segments.length - 1, idx + contextAfter);
    return {
      index: idx,
      content: segments.slice(start, end + 1).join("\n"),
      keywords: hitKeywords.get(idx) ?? [],
    };
  });
}

/**
 * Extract a 1-indexed, inclusive line range from raw text. Clamps out-of-bounds
 * ranges to the document extent and reports the clamp so the caller can note it.
 */
export function textLines(
  text: string,
  start: number,
  end: number,
): { content: string; clamped: boolean } {
  const lines = text.split("\n");
  const total = lines.length;
  const requestedStart = start;
  const requestedEnd = end;
  if (start < 1) start = 1;
  if (end > total) end = total;
  if (start > end) {
    // Invalid or empty range — return a sentinel the caller can detect.
    return { content: "", clamped: true };
  }
  const content = lines.slice(start - 1, end).join("\n");
  const clamped = requestedStart < 1 || requestedEnd > total;
  return { content, clamped };
}

/**
 * Assemble a search result string for a tool return. If hits exist, returns
 * only the matched segments with a header; otherwise returns the FULL document
 * prefixed with an explanatory note — the caller wanted selective content, so
 * give it the best available and say exactly what happened.
 *
 * `maxChars` caps the miss fallback: a keyword miss on a huge document (a
 * several-hundred-KB web page) would otherwise flood the agent's context with
 * the entire text. Callers with bounded documents (time slices) may omit it.
 */
export function searchResultToString(
  docLabel: string,
  keywords: string[],
  hits: SearchHit[],
  fullDoc: string,
  maxChars?: number,
): string {
  const kwList = keywords.length > 0 ? keywords.join(", ") : "(none)";
  if (hits.length === 0) {
    const over = maxChars !== undefined && fullDoc.length > maxChars;
    const body = over ? fullDoc.slice(0, maxChars) : fullDoc;
    return (
      `No segments matched keywords [${kwList}] in ${docLabel} — full content returned${over ? ` (truncated at ${maxChars} characters)` : ""}:\n\n` +
      body
    );
  }
  const header = `Matched ${hits.length} segment${hits.length === 1 ? "" : "s"} for [${kwList}] in ${docLabel}:\n\n`;
  return header + hits.map((h) => h.content).join("\n\n");
}
