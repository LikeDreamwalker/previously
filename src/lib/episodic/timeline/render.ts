/**
 * Timeline renderers — deterministic markdown views of the catalog.
 *
 * Two renderings of the same `TimelineIndex`:
 *  - `renderTimelineMd`  → the full projection (recall reads this as its map).
 *  - `buildTimelineBrief` → the compact per-turn injection for the system
 *    prompt (recent slices only — pointers, never content).
 */
import type { TimelineIndex, TimelineSliceEntry } from "./types";
import {
  localDateKey,
  normalizeLocale,
  relPhrase,
  weekdayLabel,
} from "@/lib/time/relative";

/** Optional user-clock context — when present, pointer lines carry a local
 *  date annotation so the agent never does date math. */
export interface SliceLineTimeOpts {
  nowIso?: string;
  timezone?: string;
  locale?: string;
  /**
   * v0.9 FROZEN mode (slice-level prompt freeze): when set, the brief lists
   * only slices CLOSED before this slice id (i.e. before the current slice
   * began) and annotates with ABSOLUTE local dates — no relative phrasing —
   * so the block stays byte-stable for the whole life of the current slice
   * and the provider prefix cache survives every turn.
   * Accepted residual drift (rare, documented): dry-slice backfill may
   * rewrite an old slice's focus mid-slice, and a concurrently closed slice
   * with an earlier id can appear (single-user deployment: effectively never).
   */
  asOfSliceId?: string;
}

/**
 * "（08-11 周二 · 6 天前）" / " (08-11 Tue · 6 days ago)" — the slice id's
 * UTC instant rendered on the user's local calendar. "" when unparseable or no
 * time context was provided.
 */
export function sliceIdRelTag(
  id: string,
  nowIso: string,
  timezone: string,
  locale: string,
): string {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return "";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
  const localKey = localDateKey(iso, timezone);
  const phrase = relPhrase(iso, nowIso, timezone, locale, { weekday: true });
  if (!localKey || !phrase) return "";
  const mmdd = localKey.slice(5);
  return normalizeLocale(locale) === "zh"
    ? `（${mmdd} ${phrase}）`
    : ` (${mmdd} ${phrase})`;
}

/**
 * "（08-11 周二）" / " (08-11 Tue)" — the ABSOLUTE local calendar date +
 * weekday of the slice id's UTC instant. No relative phrasing, no `nowIso` —
 * byte-stable by construction (v0.9 frozen timeline brief). "" when
 * unparseable.
 */
export function sliceIdAbsTag(
  id: string,
  timezone: string,
  locale: string,
): string {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return "";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
  const localKey = localDateKey(iso, timezone);
  if (!localKey) return "";
  const mmdd = localKey.slice(5);
  const wd = weekdayLabel(localKey, locale);
  const inner = wd ? `${mmdd} ${wd}` : mmdd;
  return normalizeLocale(locale) === "zh" ? `（${inner}）` : ` (${inner})`;
}

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

/** sliceLine with a local date tag on the id. Frozen mode (`asOfSliceId` set)
 *  renders the ABSOLUTE date; otherwise the relative-days tag against
 *  `nowIso`. Kept as a separate function so `slices.map(sliceLine)` call sites
 *  stay valid. */
export function sliceLineWithTime(
  s: TimelineSliceEntry,
  time: SliceLineTimeOpts,
): string {
  const turns = s.turn_count ? ` · ${s.turn_count}轮` : "";
  const tone = s.tone ? ` · ${s.tone}` : "";
  const tags = s.tags.length ? ` [${s.tags.join(",")}]` : "";
  const label = s.focus || s.summary || "*(无摘要)*";
  const when = time.asOfSliceId
    ? time.timezone
      ? sliceIdAbsTag(s.id, time.timezone, time.locale ?? "en")
      : ""
    : time.nowIso && time.timezone
      ? sliceIdRelTag(s.id, time.nowIso, time.timezone, time.locale ?? "en")
      : "";
  return `- **${s.id}**${when} ${label}${turns}${tone}${tags}`;
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
 * to read deeper. Pure pointers — never content.
 *
 * With `asOfSliceId` (v0.9 frozen mode) the brief is a SLICE-HEAD SNAPSHOT:
 * only slices closed before the current slice began, absolute dates, totals
 * computed from that fixed pool — so the string is byte-stable for the whole
 * life of the slice it is injected into (see SliceLineTimeOpts.asOfSliceId
 * for the accepted residual drift).
 */
export function buildTimelineBrief(
  idx: TimelineIndex,
  opts: { recent?: number } & SliceLineTimeOpts = {},
): string {
  const recent = opts.recent ?? 10;
  const asOf = opts.asOfSliceId;
  // Frozen mode: the pool excludes the current slice itself (active) and
  // anything started after it, so mid-slice upserts can't change the brief.
  const pool = asOf
    ? idx.slices.filter((s) => s.status === "closed" && s.id < asOf)
    : idx.slices;
  const newest = [...pool].sort((a, b) => b.id.localeCompare(a.id)).slice(0, recent);
  // Totals come from the same fixed pool in frozen mode — idx.slice_count /
  // idx.needs_marking would drift as newer slices land mid-slice.
  const totalCount = asOf ? pool.length : idx.slice_count;
  const needsMarking = asOf
    ? pool.filter((s) => s.needs_marking).length
    : idx.needs_marking;

  const lines = [
    "## Timeline (recent)",
    ...(newest.length
      ? newest.map((s) => sliceLineWithTime(s, opts))
      : ["- (empty — no slices yet)"]),
  ];
  if (totalCount > recent) {
    lines.push(
      `- 往前共 ${totalCount} 片，需要时向 recall 提问回溯`,
    );
  }
  if (needsMarking > 0) {
    lines.push(`- ${needsMarking} 片尚未生成摘要（needs_marking）`);
  }
  return lines.join("\n");
}
