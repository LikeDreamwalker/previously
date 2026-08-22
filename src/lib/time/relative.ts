/**
 * Relative-time rendering — compact, locale-aware annotations for ISO
 * dates/timestamps, computed against an explicit `nowIso` in the user's IANA
 * timezone.
 *
 * STORAGE STAYS RAW: nothing here mutates stored files. These helpers run at
 * assembly/read time only (system-prompt injection, read-tool annotation), so
 * the agent sees "2026-08-14（周五·2 天前）" / "(Fri · 2 days ago)" instead of a
 * bare date it must do arithmetic on.
 *
 * Pure module — no I/O, no Node dependencies, every function takes its time
 * inputs explicitly. NEVER THROWS: unparseable input yields "" (phrase/tag
 * helpers) or the input unchanged (annotate*), so a malformed date can never
 * take a turn down.
 */

export type RelLocale = "zh" | "en";

/** Normalize a next-intl locale (or anything) to the supported pair. */
export function normalizeLocale(locale?: string | null): RelLocale {
  return locale && locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// ─── Calendar primitives ──────────────────────────────────────────────────

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local calendar date "YYYY-MM-DD" + its weekday (0=Sunday). */
interface LocalDate {
  key: string;
  y: number;
  m: number;
  d: number;
  /** 0=Sunday … 6=Saturday, from the calendar date itself (DST-proof). */
  weekday: number;
}

function dateKeyToLocalDate(key: string): LocalDate | null {
  const m = key.match(DATE_KEY_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return {
    key,
    y,
    m: mo,
    d,
    weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(),
  };
}

/**
 * Resolve an ISO date ("YYYY-MM-DD") or timestamp to the user's LOCAL calendar
 * date in `timezone`. Date-only input is already a calendar date — it passes
 * through untouched (a `since:`/`by:` date is not an instant to convert).
 * Invalid input or timezone → null (never throws).
 */
export function localDateKey(iso: string, timezone: string): string | null {
  if (typeof iso !== "string") return null;
  const trimmed = iso.trim();
  if (DATE_KEY_RE.test(trimmed)) return trimmed;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return null;
  const zones = [timezone && timezone.trim() ? timezone : "UTC", "UTC"];
  for (const zone of zones) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(t));
      const get = (type: string) =>
        parts.find((p) => p.type === type)?.value ?? "";
      const key = `${get("year")}-${get("month")}-${get("day")}`;
      return DATE_KEY_RE.test(key) ? key : null;
    } catch {
      // unknown timezone — fall through to UTC
    }
  }
  return null;
}

/** Whole days from `nowKey` to `dateKey` (negative = in the past). */
export function dayDiff(dateKey: string, nowDateKey: string): number | null {
  const a = dateKeyToLocalDate(dateKey);
  const b = dateKeyToLocalDate(nowDateKey);
  if (!a || !b) return null;
  return Math.round(
    (Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000,
  );
}

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday label for a "YYYY-MM-DD" date: "周五" / "Fri". "" on bad input. */
export function weekdayLabel(dateKey: string, locale?: string): string {
  const ld = dateKeyToLocalDate(dateKey);
  if (!ld) return "";
  return normalizeLocale(locale) === "zh"
    ? WEEKDAYS_ZH[ld.weekday]
    : WEEKDAYS_EN[ld.weekday];
}

// ─── Relative phrasing ────────────────────────────────────────────────────

export interface RelPhraseOpts {
  /** Prefix the weekday: "周五·2 天前" / "Fri · 2 days ago" (dropped for 0/±1d and week-scale). */
  weekday?: boolean;
  /** Deadline phrasing for Horizon `by:` dates: 还剩/已逾期 vs generic 天后/天前. */
  due?: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The inner relative phrase (no parentheses) for `iso` relative to `nowIso`,
 * both resolved to calendar dates in `timezone`. "" when either side is
 * unparseable — callers then emit the original text untouched.
 *
 * zh: 今天 / 明天 / 昨天 / 周五·2 天前 / 5 天后 / 3 周前
 * en: today / tomorrow / yesterday / Fri · 2 days ago / in 5 days / 3 weeks ago
 * due: 今天到期 / 还剩 5 天 / 已逾期 2 天 — due today / in 5 days / 2 days overdue
 */
export function relPhrase(
  iso: string,
  nowIso: string,
  timezone: string,
  locale: string,
  opts: RelPhraseOpts = {},
): string {
  const key = localDateKey(iso, timezone);
  const nowKey = localDateKey(nowIso, timezone);
  if (!key || !nowKey) return "";
  const diff = dayDiff(key, nowKey);
  if (diff === null) return "";
  const zh = normalizeLocale(locale) === "zh";
  const wd =
    opts.weekday && Math.abs(diff) > 1 && Math.abs(diff) <= 14
      ? weekdayLabel(key, locale)
      : "";
  const withWd = (phrase: string) =>
    wd ? (zh ? `${wd}·${phrase}` : `${wd} · ${phrase}`) : phrase;

  if (opts.due) {
    if (diff === 0) return zh ? "今天到期" : "due today";
    if (diff === 1) return zh ? "明天到期" : "due tomorrow";
    if (diff > 14) {
      const w = Math.round(diff / 7);
      return zh ? `还剩 ${w} 周` : `in ${plural(w, "week")}`;
    }
    if (diff > 1) return zh ? `还剩 ${diff} 天` : `in ${plural(diff, "day")}`;
    if (diff < -14) {
      const w = Math.round(-diff / 7);
      return zh ? `已逾期 ${w} 周` : `${plural(w, "week")} overdue`;
    }
    return zh ? `已逾期 ${-diff} 天` : `${plural(-diff, "day")} overdue`;
  }

  if (diff === 0) return zh ? "今天" : "today";
  if (diff === 1) return zh ? "明天" : "tomorrow";
  if (diff === -1) return zh ? "昨天" : "yesterday";
  if (diff > 14) {
    const w = Math.round(diff / 7);
    return zh ? `${w} 周后` : `in ${plural(w, "week")}`;
  }
  if (diff > 1) return withWd(zh ? `${diff} 天后` : `in ${plural(diff, "day")}`);
  if (diff < -14) {
    const w = Math.round(-diff / 7);
    return zh ? `${w} 周前` : `${plural(w, "week")} ago`;
  }
  return withWd(zh ? `${-diff} 天前` : `${plural(-diff, "day")} ago`);
}

/** relPhrase wrapped in locale-appropriate parentheses; "" stays "". */
export function relTag(
  iso: string,
  nowIso: string,
  timezone: string,
  locale: string,
  opts: RelPhraseOpts = {},
): string {
  const phrase = relPhrase(iso, nowIso, timezone, locale, opts);
  if (!phrase) return "";
  return normalizeLocale(locale) === "zh" ? `（${phrase}）` : `(${phrase})`;
}

/**
 * "2026-08-14（周五·2 天前）" / "2026-08-14 (Fri · 2 days ago)" — the local
 * calendar date with its weekday + relative tag. Unparseable input is returned
 * UNCHANGED (never throws).
 */
export function annotateDate(
  iso: string,
  nowIso: string,
  timezone: string,
  locale: string,
): string {
  const key = localDateKey(iso, timezone);
  if (!key) return iso;
  const tag = relTag(iso, nowIso, timezone, locale, { weekday: true });
  if (!tag) return iso;
  const sep = normalizeLocale(locale) === "zh" ? "" : " ";
  return `${key}${sep}${tag}`;
}

// ─── Card injection (v5 user card) ────────────────────────────────────────

/**
 * Annotate the INJECTED copy of the user card: Now `since:` dates get a
 * compact relative tag (`since: 2026-08-14（2 天前）`), Horizon `by:` dates get
 * deadline phrasing (`by: 2026-08-23（还剩 5 天）` / `（已逾期 2 天）`). The
 * stored file is never rewritten — this runs on the prompt-assembly string
 * only. Dates that don't parse pass through untouched.
 *
 * `anchorIso` is the instant the relative phrases anchor to. v0.9: the caller
 * passes the SLICE START (not the current time) — the phrases are
 * day-granular, so the injected card stays byte-identical for the slice's
 * whole life (prefix-cache freeze).
 */
export function annotateCardTimes(
  cardContent: string,
  anchorIso: string,
  timezone: string,
  locale: string,
): string {
  if (!cardContent) return cardContent;
  const sep = normalizeLocale(locale) === "zh" ? "" : " ";
  return cardContent
    .replace(
      /(\|\s*since:\s*)(\d{4}-\d{2}-\d{2})/g,
      (m, prefix: string, date: string) => {
        const tag = relTag(date, anchorIso, timezone, locale);
        return tag ? `${prefix}${date}${sep}${tag}` : m;
      },
    )
    .replace(
      /(—\s*by:\s*)(\d{4}-\d{2}-\d{2})/g,
      (m, prefix: string, date: string) => {
        const tag = relTag(date, anchorIso, timezone, locale, { due: true });
        return tag ? `${prefix}${date}${sep}${tag}` : m;
      },
    );
}

// ─── Date anchors (turn-priming reference table) ─────────────────────────

function shiftKey(key: string, days: number): string {
  const ld = dateKeyToLocalDate(key);
  if (!ld) return key;
  return new Date(Date.UTC(ld.y, ld.m - 1, ld.d + days))
    .toISOString()
    .slice(0, 10);
}

function withWeekday(key: string, locale?: string): string {
  const wd = weekdayLabel(key, locale);
  if (!wd) return key;
  return normalizeLocale(locale) === "zh" ? `${key}（${wd}）` : `${key} (${wd})`;
}

/**
 * A small precomputed reference table so the model can resolve "上周五" /
 * "last Friday" without doing date arithmetic itself: today's weekday, this
 * week's Monday, last week's Mon–Sun range, tomorrow, this weekend. All dates
 * are the user's LOCAL calendar. Returns [] when `nowIso` is unparseable.
 */
export function buildDateAnchors(
  nowIso: string,
  timezone: string,
  locale?: string,
): string[] {
  const todayKey = localDateKey(nowIso, timezone);
  const today = todayKey ? dateKeyToLocalDate(todayKey) : null;
  if (!today) return [];
  const zh = normalizeLocale(locale) === "zh";

  // Days since this week's Monday (ISO week: Monday-first).
  const sinceMonday = (today.weekday + 6) % 7;
  const monday = shiftKey(today.key, -sinceMonday);
  const lastMonday = shiftKey(monday, -7);
  const lastSunday = shiftKey(monday, -1);
  const tomorrow = shiftKey(today.key, 1);
  const saturday = shiftKey(monday, 5);
  const sunday = shiftKey(monday, 6);

  const w = (key: string) => withWeekday(key, locale);
  return zh
    ? [
        `今天：${w(today.key)}`,
        `本周一：${monday}`,
        `上周：${w(lastMonday)} 至 ${w(lastSunday)}`,
        `明天：${w(tomorrow)}`,
        `本周末：${w(saturday)} 至 ${w(sunday)}`,
      ]
    : [
        `Today: ${w(today.key)}`,
        `This week's Monday: ${monday}`,
        `Last week: ${w(lastMonday)} → ${w(lastSunday)}`,
        `Tomorrow: ${w(tomorrow)}`,
        `This weekend: ${w(saturday)} → ${w(sunday)}`,
      ];
}
