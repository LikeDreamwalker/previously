"use client";

import { useEffect, useRef } from "react";
import { NumberTicker } from "@/components/ui/number-ticker";

// ─── Types ──────────────────────────────────────────────────────────────

interface TimeDisplayProps {
  /** ISO 8601 timestamp. If invalid, renders nothing (null). */
  timestamp: string;
  /** "full" = date + time, "date" = month/day only, "time" = HH:MM only */
  mode?: "full" | "date" | "time";
  /** "sm" = compact timestamp (default). "md" = subtitle (time-travel readout).
   *  "xl" = near-H1. */
  size?: "sm" | "md" | "xl";
  className?: string;
  /** When provided, each field ROLLS from this time's value to `timestamp`'s
   *  value — direction is automatic (reverse when the target is earlier). */
  from?: string;
  /** Fired once the from→to roll settles (only when `from` is provided). */
  onRollComplete?: () => void;
}

/** Time-travel roll pacing: the digits roll from their start values the moment
 *  they enter, the NumberTicker spring settles, then a hold at the target
 *  before `onRollComplete` fires — so the clock visibly lands, pauses, then
 *  leaves. */
const ROLL_SETTLE_MS = 1000;
const ROLL_HOLD_MS = 1200;

// ─── Component ──────────────────────────────────────────────────────────

/**
 * Animated monospace time display.
 *
 * Uses NumberTicker for each digit — numbers animate in when they enter the
 * viewport. Falls back to rendering nothing if the timestamp is invalid.
 *
 * With `from`, each field rolls from that time's value to `timestamp`'s value
 * (forward or reverse automatically), and `onRollComplete` fires once settled
 * — this is the time-travel transition readout.
 */
export function TimeDisplay({
  timestamp,
  mode = "full",
  size = "sm",
  className = "",
  from,
  onRollComplete,
}: TimeDisplayProps) {
  const fromD = from ? new Date(from) : null;
  const rollFrom = fromD && !isNaN(fromD.getTime()) ? fromD : null;
  const onRollCompleteRef = useRef(onRollComplete);
  onRollCompleteRef.current = onRollComplete;

  // Signal once the full roll has played (delay → spring → hold), so the
  // caller can fade out and swap in the real content. (Hook before return.)
  useEffect(() => {
    if (!from || !onRollCompleteRef.current) return;
    if (isNaN(new Date(from).getTime())) return;
    const t = setTimeout(
      () => onRollCompleteRef.current?.(),
      ROLL_SETTLE_MS + ROLL_HOLD_MS,
    );
    return () => clearTimeout(t);
  }, [from, timestamp]);

  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;

  const hours = d.getHours();
  const minutes = d.getMinutes();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  // Start each digit's roll: from the `from` time when rolling, else a short
  // offset below the value (the entrance animation) so we never scroll through
  // thousands of numbers for a 4-digit year.
  const yearStart = rollFrom ? rollFrom.getFullYear() : Math.max(0, year - 30);
  const monthStart = rollFrom ? rollFrom.getMonth() + 1 : Math.max(1, month - 3);
  const dayStart = rollFrom ? rollFrom.getDate() : Math.max(1, day - 10);
  const hourStart = rollFrom ? rollFrom.getHours() : Math.max(0, hours - 6);
  const minuteStart = rollFrom ? rollFrom.getMinutes() : Math.max(0, minutes - 10);

  const sizeClass =
    size === "xl"
      ? "text-3xl sm:text-4xl lg:text-5xl"
      : size === "md"
        ? "text-lg"
        : "text-[0.6rem]";
  // More breathing room between the date and time groups when enlarged.
  const dateTimeGap = size === "sm" ? "mx-1" : "mx-3";

  const showDate = mode === "full" || mode === "date";
  const showTime = mode === "full" || mode === "time";

  return (
    <span
      className={`inline-flex items-baseline gap-px font-mono tabular-nums ${sizeClass} text-inherit ${className}`}
    >
      {showDate && (
        <>
          <NumberTicker value={year} startValue={yearStart} className="![color:inherit]" />
          <span>/</span>
          <NumberTicker value={month} startValue={monthStart} className="![color:inherit]" />
          <span>/</span>
          <NumberTicker value={day} startValue={dayStart} minIntegerDigits={2} className="![color:inherit]" />
          {showTime && <span className={dateTimeGap} />}
        </>
      )}
      {showTime && (
        <>
          <NumberTicker value={hours} startValue={hourStart} minIntegerDigits={2} className="![color:inherit]" />
          <span>:</span>
          <NumberTicker value={minutes} startValue={minuteStart} minIntegerDigits={2} className="![color:inherit]" />
        </>
      )}
    </span>
  );
}

// ─── Helper ─────────────────────────────────────────────────────────────

/** True when `iso` is the same calendar day as today (local time). */
export function sameDay(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
