"use client";

import { useTranslations } from "next-intl";
import { NumberTicker } from "@/components/ui/number-ticker";
import { TimeDisplay } from "./time-display";

// ─── Relative label computation ─────────────────────────────────────────

export type RelativeUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

export type RelativeResult =
  | { kind: "moments"; dir: "before" | "after" }
  | { kind: "count"; dir: "before" | "after"; unit: RelativeUnit; count: number }
  | null;

/**
 * The delta FROM `fromIso` TO `toIso`, for the label. Anchored to `fromIso` —
 * the slice the viewer is currently ON — so traveling from a past slice back
 * to "now" reads as "1 year later", not "moments ago".
 */
export function relativeBetween(fromIso: string, toIso: string): RelativeResult {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  const diff = b - a;
  const abs = Math.abs(diff);
  const dir = diff < 0 ? "before" : "after";
  if (abs < 5 * 60_000) return { kind: "moments", dir };
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return { kind: "count", dir, unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "count", dir, unit: "hour", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { kind: "count", dir, unit: "day", count: days };
  if (days < 35) return { kind: "count", dir, unit: "week", count: Math.floor(days / 7) };
  if (days < 365) return { kind: "count", dir, unit: "month", count: Math.floor(days / 30) };
  return { kind: "count", dir, unit: "year", count: Math.floor(days / 365) };
}

// ─── Types ──────────────────────────────────────────────────────────────

interface RelativeTimeReadoutProps {
  /** The destination time — shown as the subtitle, and the label's target. */
  timestamp?: string;
  /** Roll start — the label + subtitle are computed as the delta FROM this
   *  time (the slice the viewer is currently on) TO `timestamp`. */
  from?: string;
  /** Fired once the from→to roll settles. */
  onRollComplete?: () => void;
  className?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

/**
 * The time-travel readout shown during slice navigation: a big relative label
 * (anchored to the slice the viewer is currently on — so jumping back to "now"
 * from a year-old slice reads "1 year later") as the title, with the actual
 * time as a smaller rolling subtitle. The label's count rolls via NumberTicker
 * — the shared time component, in monospace — straight from 0 on entry.
 */
export function RelativeTimeReadout({
  timestamp,
  from,
  onRollComplete,
  className = "",
}: RelativeTimeReadoutProps) {
  const t = useTranslations("relative");
  const rel = from && timestamp ? relativeBetween(from, timestamp) : null;

  // The title. `moments` stays static text; a counted label is rendered as
  //  prefix + <rolling count> + suffix  (the suffix carries the ICU plural for
  //  the target count; zh needs neither a prefix nor plural forms).
  const title = (() => {
    if (!rel) return "";
    if (rel.kind === "moments") return t(`moments.${rel.dir}`);
    const prefix = rel.dir === "after" ? t("prefixAfter") : "";
    const suffix = t(`${rel.unit}.${rel.dir}`, { count: rel.count });
    // The count rolls straight from 0 the moment it enters. Unlike the
    // subtitle it has no meaningful initial value (nothing to hold a beat
    // for), so no delay — it just counts up as the readout fades in.
    return (
      <>
        {prefix}
        <NumberTicker value={rel.count} className="![color:inherit]" />
        {suffix}
      </>
    );
  })();

  return (
    <div data-testid="relative-time" className={`flex flex-col items-center gap-2 ${className}`}>
      <span className="inline-flex items-baseline gap-px text-4xl font-light tracking-tight text-foreground sm:text-5xl">
        {title}
      </span>
      {timestamp && (
        <TimeDisplay
          timestamp={timestamp}
          from={from}
          size="md"
          className="font-medium text-muted-foreground"
          onRollComplete={onRollComplete}
        />
      )}
    </div>
  );
}
