/**
 * Timeline renderers — deterministic markdown views of the catalog.
 *
 * Two renderings of the same `TimelineIndex`:
 *  - `renderTimelineMd`  → the full projection (recall reads this as its map).
 *  - `buildTimelineBrief` → the compact per-turn injection for the system
 *    prompt (recent slices only — pointers, never content).
 */
import type { TimelineIndex, TimelineSliceEntry } from "./types";

interface EraGroup {
  era: string;
  days: Array<{ day: string; slices: TimelineSliceEntry[] }>;
}

/** Group slices into era (YYYY-MM) → day (YYYY-MM-DD) buckets. */
export function groupByEraAndDay(
  slices: TimelineSliceEntry[],
): EraGroup[] {
  const eras = new Map<string, Map<string, TimelineSliceEntry[]>>();
  for (const s of slices) {
    const era = s.date.slice(0, 7); // "YYYY-MM"
    const day = s.date;
    let days = eras.get(era);
    if (!days) {
      days = new Map();
      eras.set(era, days);
    }
    let bucket = days.get(day);
    if (!bucket) {
      bucket = [];
      days.set(day, bucket);
    }
    bucket.push(s);
  }
  // Newest era first; within an era, newest day first; within a day, newest slice first.
  return [...eras.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([era, days]) => ({
      era,
      days: [...days.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, slices]) => ({
          day,
          slices: [...slices].sort((a, b) => b.id.localeCompare(a.id)),
        })),
    }));
}

/** One compact pointer line for a slice. The id stays full so the reader can
 *  resolve it with a tool (readSliceSummary / readSlice) without re-deriving
 *  the era/day from the surrounding headers. */
export function sliceLine(s: TimelineSliceEntry): string {
  const turns = s.turn_count ? ` · ${s.turn_count}轮` : "";
  const tone = s.tone ? ` · ${s.tone}` : "";
  const tags = s.tags.length ? ` [${s.tags.join(",")}]` : "";
  const label = s.focus || s.summary || "*(无摘要)*";
  return `- **${s.id}** ${label}${turns}${tone}${tags}`;
}

/** The full projection — every slice, era- and day-grouped, newest first. */
export function renderTimelineMd(idx: TimelineIndex): string {
  const header = [
    "# Timeline",
    "",
    `_Generated: ${idx.updated_at}_`,
    `_Slices: ${idx.slice_count}_`,
    `_Needs marking: ${idx.needs_marking}_`,
    `_Schema: ${idx._schema}_`,
    "",
  ].join("\n");

  const body: string[] = [];
  for (const era of groupByEraAndDay(idx.slices)) {
    body.push(`## ${era.era}`);
    for (const day of era.days) {
      body.push(`### ${day.day.slice(5)}`); // "MM-DD"
      for (const s of day.slices) {
        body.push(sliceLine(s));
      }
      body.push("");
    }
  }
  return header + "\n" + body.join("\n");
}

/**
 * The compact per-turn brief: recent slices + catalog totals + an invitation
 * to read deeper. Pure pointers — never content. Fits in the system prompt's
 * variable tail.
 */
export function buildTimelineBrief(
  idx: TimelineIndex,
  opts: { recent?: number } = {},
): string {
  const recent = opts.recent ?? 10;
  const newest = [...idx.slices].sort((a, b) => b.id.localeCompare(a.id)).slice(0, recent);

  const lines = [
    "## Timeline (recent)",
    ...(newest.length ? newest.map(sliceLine) : ["- (empty — no slices yet)"]),
  ];
  if (idx.slice_count > recent) {
    lines.push(
      `- 往前共 ${idx.slice_count} 片，可用 readTimelineWindow / readSliceSummary 回溯`,
    );
  }
  if (idx.needs_marking > 0) {
    lines.push(`- ${idx.needs_marking} 片尚未生成摘要（needs_marking）`);
  }
  return lines.join("\n");
}
