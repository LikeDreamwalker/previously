"use client";

import { useRef, useCallback } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";
import type { SliceSummary } from "@/hooks/use-timeline";
import { TimeDisplay } from "./time-display";

// ─── Types ──────────────────────────────────────────────────────────────

interface HorizontalTimelineProps {
  slices: SliceSummary[];
  selectedId: string | null;
  onSelect: (sliceId: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────

export function HorizontalTimeline({
  slices,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  loadingMore,
}: HorizontalTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Wheel → horizontal scroll
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!scrollRef.current) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      scrollRef.current.scrollLeft += e.deltaY;
    }
  }, []);

  return (
    <div
      ref={scrollRef}
      onWheel={handleWheel}
      className="overflow-x-auto scrollbar-none"
    >
      <div className="relative flex justify-between min-w-full px-6 py-2">
        {/* Horizontal connector line — runs through all dots */}
        <div className="absolute left-6 right-6 top-1/2 h-px bg-border/40 -translate-y-px" />
        {/* Load earlier */}
        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="flex shrink-0 items-center justify-center w-14 py-1 text-[0.6rem] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {loadingMore ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ChevronLeft className="h-3 w-3" />
            )}
          </button>
        )}

        {/* Slice markers — newest on the right */}
        {slices
          .slice()
          .reverse()
          .map((slice) => {
            const isSelected = slice.slice_id === selectedId;
            return (
              <button
                key={slice.slice_id}
                onClick={() => onSelect(slice.slice_id)}
                className={`flex shrink-0 flex-col items-center gap-0.5 w-14 py-1 rounded-md transition-colors ${
                  isSelected
                    ? "text-brand-600 dark:text-brand-400"
                    : "text-muted-foreground/50 hover:text-muted-foreground"
                }`}
              >
                <TimeDisplay timestamp={slice.start} mode="date" />
                <span
                  className={`h-1.5 w-1.5 rounded-full transition-all ${
                    isSelected
                      ? "bg-brand-500 scale-110 ring-1 ring-brand-500/20"
                      : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                  }`}
                />
                <TimeDisplay timestamp={slice.start} mode="time" />
              </button>
            );
          })}

        {/* NOW node */}
        <button
          onClick={() => onSelect("now")}
          className={`flex shrink-0 flex-col items-center gap-0.5 w-14 py-1 rounded-md transition-colors ${
            selectedId === "now"
              ? "text-brand-600 dark:text-brand-400"
              : "text-muted-foreground/50 hover:text-muted-foreground"
          }`}
        >
          <TimeDisplay timestamp={new Date().toISOString()} mode="date" />
          <span
            className={`h-2 w-2 rounded-full border transition-all ${
              selectedId === "now"
                ? "bg-brand-500 border-brand-500 scale-110 ring-1 ring-brand-500/20"
                : "bg-transparent border-muted-foreground/30 hover:border-muted-foreground/50"
            }`}
          />
          <span className="text-[0.6rem] leading-none font-medium">现在</span>
        </button>
      </div>
    </div>
  );
}
