"use client";

import { useLayoutEffect, useState } from "react";

/**
 * matchMedia-backed "(max-width: 767.98px)" switch — the Tailwind `md:`
 * breakpoint. Consulted in a layout effect so a phone flips to the mobile
 * form BEFORE the first paint (the SSR first render stays desktop so
 * hydration matches). Extracted from timeline-wheel.tsx: the stream time
 * rail (desktop-only, §1.3 Rev 2) shares the same gear decision.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useLayoutEffect(() => {
    const mq = window.matchMedia("(max-width: 767.98px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}
