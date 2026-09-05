/**
 * Split a text into alternating plain / matched segments for keyword
 * highlighting (the search palette's snippets). Case-insensitive,
 * non-overlapping, left to right. An empty needle passes the text through
 * as one plain segment.
 */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function splitHighlight(text: string, needle: string): HighlightSegment[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [{ text, match: false }];
  const hay = text.toLowerCase();
  const out: HighlightSegment[] = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(n, i);
    if (at === -1) break;
    if (at > i) out.push({ text: text.slice(i, at), match: false });
    out.push({ text: text.slice(at, at + n.length), match: true });
    i = at + n.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), match: false });
  return out;
}
