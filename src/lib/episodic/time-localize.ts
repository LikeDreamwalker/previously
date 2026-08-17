/**
 * Local-time annotation — the system pre-renders user-local time so the agent
 * never has to convert UTC slice timestamps itself.
 *
 * Slice ids and turn timestamps are stored in UTC (slice_id derives from UTC
 * time). Every read tool that surfaces them runs the raw content through these
 * helpers so the model sees "this slice happened at local time X, N days ago"
 * instead of a bare UTC instant it must convert by hand.
 */
import { formatLocalTime } from "@/lib/turn-priming";
import { normalizeLocale, relPhrase } from "@/lib/time/relative";

/** Matches the date/time prefix of a slice id in either dash or slash form. */
const SLICE_ID_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})[-/](\d{2})(\d{2})/;

/** Optional annotation context: the reference "now" and the UI locale. */
export interface LocalizeOpts {
  /** Reference instant for the relative-days phrase (defaults to actual now). */
  nowIso?: string;
  /** "zh" | "en" — the relative phrase follows it (default "zh", matching the
   *  existing Chinese banner text). */
  locale?: string;
}

/** The user's local clock for a UTC instant, as "HH:MM". */
function localClock(iso: string, timezone: string): string {
  const local = formatLocalTime(iso, timezone).local; // "07 Aug 2026, 22:07"
  const sep = local.lastIndexOf(", ");
  return sep >= 0 ? local.slice(sep + 2) : local;
}

/** "10 天前" / "10 days ago" for a UTC instant — "" when unparseable. */
function relFor(
  iso: string,
  timezone: string,
  opts?: LocalizeOpts,
): string {
  return relPhrase(
    iso,
    opts?.nowIso ?? new Date().toISOString(),
    timezone,
    opts?.locale ?? "zh",
  );
}

/** Local-time banner for a slice, derived from its UTC-derived slice id. */
export function sliceLocalBanner(
  sliceId: string,
  timezone: string,
  opts?: LocalizeOpts,
): string {
  const m = sliceId.match(SLICE_ID_RE);
  if (!m) return "";
  const [, y, mo, d, h, mi] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
  const info = formatLocalTime(iso, timezone);
  const rel = relFor(iso, timezone, opts);
  return (
    `> [时间] 该时间片发生于用户当地时间 ${info.local}` +
    `（${info.zone}${info.offset ? `, ${info.offset}` : ""}）` +
    `${rel ? ` · ${rel}` : ""}。下方时间戳为原始 UTC。`
  );
}

/**
 * Annotate raw slice markdown: prepend a local-time banner and append
 * `（本地 HH:MM · N 天前）` to every `## Turn … — <ISO> (role)` header line.
 */
export function annotateSliceWithLocalTime(
  raw: string,
  timezone: string,
  sliceId: string,
  opts?: LocalizeOpts,
): string {
  const banner = sliceLocalBanner(sliceId, timezone, opts);
  const headerRe = /(## Turn [^\n]*?—\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g;
  const zh = normalizeLocale(opts?.locale ?? "zh") === "zh";
  const annotated = raw.replace(headerRe, (full, stamp) => {
    const isoMatch = stamp.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
    if (!isoMatch) return full;
    const clock = localClock(isoMatch[0], timezone);
    const rel = relFor(isoMatch[0], timezone, opts);
    const inner = rel ? `${clock} · ${rel}` : clock;
    return zh ? `${stamp}（本地 ${inner}）` : `${stamp} (local ${inner})`;
  });
  return banner ? `${banner}\n\n${annotated}` : annotated;
}

/** The user's local clock for a slice id's instant, or null when unparseable. */
export function sliceIdLocalClock(
  sliceId: string,
  timezone: string,
): string | null {
  const m = sliceId.match(SLICE_ID_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return localClock(`${y}-${mo}-${d}T${h}:${mi}:00.000Z`, timezone);
}

/**
 * The relative-days phrase for a slice id's instant ("2 天前" / "2 days ago"),
 * or null when unparseable. Used by read-tool hit annotations.
 */
export function sliceIdRelPhrase(
  sliceId: string,
  timezone: string,
  opts?: LocalizeOpts,
): string | null {
  const m = sliceId.match(SLICE_ID_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const rel = relFor(`${y}-${mo}-${d}T${h}:${mi}:00.000Z`, timezone, opts);
  return rel || null;
}
