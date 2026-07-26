"use client";

import { NumberTicker } from "@/components/ui/number-ticker";

// ─── Types ──────────────────────────────────────────────────────────────

interface TimeDisplayProps {
  /** ISO 8601 timestamp. If invalid, renders nothing (null). */
  timestamp: string;
  /** "full" = date + time, "date" = month/day only, "time" = HH:MM only */
  mode?: "full" | "date" | "time";
  className?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

/**
 * Animated monospace time display.
 *
 * Uses NumberTicker for each digit — numbers animate in when they enter the
 * viewport. Falls back to rendering nothing if the timestamp is invalid.
 */
export function TimeDisplay({
  timestamp,
  mode = "full",
  className = "",
}: TimeDisplayProps) {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;

  const hours = d.getHours();
  const minutes = d.getMinutes();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  // Start each digit's animation close to its target so we never
  // scroll through thousands of numbers for a 4-digit year.
  const yearStart = Math.max(0, year - 30);
  const monthStart = Math.max(1, month - 3);
  const dayStart = Math.max(1, day - 10);
  const hourStart = Math.max(0, hours - 6);
  const minuteStart = Math.max(0, minutes - 10);

  const showDate = mode === "full" || mode === "date";
  const showTime = mode === "full" || mode === "time";

  return (
    <span
      className={`inline-flex items-baseline gap-px font-mono tabular-nums text-[0.6rem] text-inherit ${className}`}
    >
      {showDate && (
        <>
          <NumberTicker value={year} startValue={yearStart} className="![color:inherit] text-[0.55rem]" />
          <span className="text-[0.5rem]">/</span>
          <NumberTicker value={month} startValue={monthStart} className="![color:inherit] text-[0.55rem]" />
          <span className="text-[0.5rem]">/</span>
          <NumberTicker value={day} startValue={dayStart} minIntegerDigits={2} className="![color:inherit] text-[0.55rem]" />
          {showTime && <span className="mx-0.5" />}
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
