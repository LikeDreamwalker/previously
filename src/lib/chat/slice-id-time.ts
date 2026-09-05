/**
 * Slice-id → clock label for the UI (v0.10 M2). A slice id
 * (YYYY-MM-DD-HHMM) is a UTC instant; `formatSliceIdLabel` renders it in the
 * VIEWER's locale and (by default) the browser's local timezone — the user
 * reads their own wall clock, never the UTC label. Pass `timeZone` in tests
 * for determinism.
 */

const SLICE_ID_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/;

/** The UTC ISO instant a slice id encodes, or null for a malformed id. */
export function sliceIdToIso(sliceId: string): string | null {
  const m = sliceId.match(SLICE_ID_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
}

/** Short "02-10 14:30"-style label (locale-formatted), "" for a bad id. */
export function formatSliceIdLabel(
  sliceId: string,
  locale: string,
  timeZone?: string,
): string {
  const iso = sliceIdToIso(sliceId);
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}
