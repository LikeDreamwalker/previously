"use client";

import { useLocale, useTranslations } from "next-intl";
import { sameDay } from "./time-display";

/** The floating indicator's label: time-only within today, full date (+time)
 *  once it crosses a day boundary (design §1.3). */
export function formatIndicatorTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  if (sameDay(iso)) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * The transient "where am I in time" pill (design §1.3) — surfaces at the top
 * edge of the viewport while scrolling, fades ~1s after the scroll stops.
 * Zero permanent chrome: scroll reveals it, stillness hides it.
 */
export function StreamTimeIndicator({
  timeIso,
  visible,
}: {
  timeIso: string | null;
  visible: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("chat.timeIndicator");
  const label = timeIso ? formatIndicatorTime(timeIso, locale) : "";

  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 transition-opacity duration-300 ${
        visible && label ? "opacity-100" : "opacity-0"
      }`}
    >
      <span
        role="status"
        aria-label={label ? t("label", { time: label }) : undefined}
        className="block rounded-full border border-border/50 bg-background/85 px-3 py-1 font-mono text-[0.65rem] tabular-nums text-muted-foreground shadow-sm backdrop-blur-sm"
      >
        {label}
      </span>
    </div>
  );
}
