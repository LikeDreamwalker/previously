"use client";

/**
 * The odometer-style rolling digit family — extracted from timeline-wheel.tsx
 * so the chat mode's left time rail (v0.10 §1.3 Rev 2) shares the exact same
 * animation (§5.4: "RollingDigit/useRollingNumber 复用于对话模式的左侧时间标尺").
 */
import { useEffect, useRef, useState } from "react";

/**
 * A single digit that rolls (odometer-style) to a new value whenever it
 * changes, counting through the intermediate integers. Scrolling into the
 * past moves targets downward → digits count down; forward → count up.
 * Tweens from the *currently displayed* value so rapid scrolls retarget
 * smoothly instead of jumping.
 */
export function useRollingNumber(target: number): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === displayRef.current) return;
    cancelAnimationFrame(rafRef.current ?? 0);
    const from = displayRef.current;
    const to = target;
    const dur = Math.min(320, Math.max(70, Math.abs(to - from) * 28));
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic — no overshoot
      const v = Math.round(from + (to - from) * eased);
      displayRef.current = v;
      setDisplay(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target]);

  return display;
}

export function RollingDigit({ value }: { value: number }) {
  const display = useRollingNumber(value);
  return (
    <span className="inline-block w-[0.62em] text-center tabular-nums">
      {display}
    </span>
  );
}

/** A zero-padded numeric field (year, month, day, …) whose digits roll. */
export function RollingField({ value, digits = 2 }: { value: number; digits?: number }) {
  const str = String(value).padStart(digits, "0");
  return (
    <span className="inline-flex">
      {str.split("").map((ch, i) => (
        <RollingDigit key={i} value={Number(ch)} />
      ))}
    </span>
  );
}
