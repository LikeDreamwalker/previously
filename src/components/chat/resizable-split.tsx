"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface ResizableSplitProps {
  left: ReactNode;
  right: ReactNode;
  /** True while the timeline is expanded to cover the content with a blur mask. */
  expanded?: boolean;
  className?: string;
}

/**
 * The split layout: a content-fitted timeline on the left and a conversation on
 * the right that scrolls internally. There is no drag resize — while collapsed
 * the timeline shrinks to its own content width (measured live, so it follows
 * the labels instead of a hardcoded 72/180px), and it expands in place to fill
 * the whole region.
 *
 * Expanding is NOT a separate drawer: the SAME timeline widens in place to
 * cover the region, with a translucent blur mask fading in over the content
 * behind. The right panel scrolls internally so the page itself never scrolls.
 */
export function ResizableSplit({
  left,
  right,
  expanded = false,
  className = "",
}: ResizableSplitProps) {
  // The collapsed width = the timeline's own content width, measured via the
  // wrapper below. 180 is only the first-frame fallback while that measurement
  // runs — the useLayoutEffect below corrects it before the first paint, so a
  // phone never flashes a desktop-wide column.
  const [contentWidth, setContentWidth] = useState(180);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth;
      if (w > 0) setContentWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`pt-12 ${className}`}>
      {/* Explicit-height wrapper so the overlay has a definite height — the
          timeline spans the full area below the fixed AppHeader. */}
      <div className="h-[calc(100vh-3rem)]">
        <div className="relative h-full">
          {/* Right content — stays behind the timeline. Its left offset equals
              the collapsed timeline width so nothing overlaps until expanded. */}
          <div
            className="h-full overflow-y-auto pb-24 transition-[margin-left] duration-300 ease-in-out"
            style={{ marginLeft: expanded ? 0 : contentWidth }}
          >
            {/* h-full (not min-h-full): a definite height lets the empty-state
                chain min-h-full down to its children so the hero centers both
                ways inside the content area. Long content still overflows and
                the parent scrolls. */}
            <div className="h-full">{right}</div>
          </div>

          {/* Timeline — one instance, widens in place over the content. */}
          <div
            className="absolute inset-y-0 left-0 z-20 transition-[width] duration-300 ease-in-out"
            style={{ width: expanded ? "100%" : contentWidth }}
          >
            {/* Blur mask: while expanded, the covered content shows through a
                translucent blur — a scrim, not an opaque drawer. */}
            <div
              aria-hidden
              className={`absolute inset-0 bg-background/60 backdrop-blur-md transition-opacity duration-300 ${
                expanded ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
            />
            {/* The content wrapper: shrink-wrapped to the timeline's own width
                while collapsed (w-max → whatever the labels need), full-bleed
                while expanded. The ResizeObserver above measures this box. */}
            <div ref={contentRef} className={`relative h-full ${expanded ? "w-full" : "w-max"}`}>
              {left}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
