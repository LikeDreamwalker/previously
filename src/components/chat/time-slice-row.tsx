"use client";

import { useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { SliceSummary } from "@/hooks/use-timeline";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import { Loader2, ChevronUp, ChevronDown, ChevronRight } from "lucide-react";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MarkdownRenderer } from "./markdown";

// ─── Helpers ────────────────────────────────────────────────────────────

/** Compact char-count value (no unit) — the unit is applied by the translator. */
function formatCharCount(len: number): string {
  if (len < 1000) return `${len}`;
  return `${(len / 1000).toFixed(1)}k`;
}

// ─── Memory turn — reuses shadcn Message + Bubble ───────────────────────

function MemoryTurn({ content, role }: { content: string; role: string }) {
  const t = useTranslations("timeline.row");
  const isUser = role === "user";
  const isTruncated = content.length > 300;
  const [expanded, setExpanded] = useState(false);
  const display = !isTruncated || expanded ? content : content.slice(0, 300) + "…";

  return (
    <div>
      <Message align={isUser ? "end" : "start"} className="gap-1 py-0.5">
        <MessageContent className="min-w-0">
          <Bubble variant={isUser ? "default" : "secondary"}>
            <BubbleContent>
              {isUser ? (
                <span className="whitespace-pre-wrap text-sm">{display}</span>
              ) : (
                <MarkdownRenderer content={display} />
              )}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      {isTruncated && (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[0.6rem] text-muted-foreground hover:text-muted-foreground transition-colors px-2"
          >
            {expanded
              ? t("collapse")
              : t("expandAll", {
                  value: t("charCount", { value: formatCharCount(content.length) }),
                })}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Date formatting ────────────────────────────────────────────────────

/**
 * Group label for a slice's date. Returns a translated "today"/"yesterday"
 * for the most recent days, else a locale-formatted date. Used both as the
 * grouping key and the fallback header when no animated DateGroupHeader shows.
 */
export function formatSliceDate(
  start: string,
  t: (key: string) => string,
  locale: string,
): string {
  const now = new Date();
  const d = new Date(start);
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return t("date.today");
  if (diffDays === 1) return t("date.yesterday");
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    locale,
    sameYear
      ? { month: "long", day: "numeric" }
      : { year: "numeric", month: "long", day: "numeric" },
  ).format(d);
}

export function formatDateGroup(
  start: string,
  locale: string,
): {
  yearNumber?: number;
  monthNumber: number;
  monthName: string;
  day: number;
} | null {
  const now = new Date();
  const d = new Date(start);
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays <= 1) return null;

  const monthNumber = d.getMonth() + 1;
  const year = d.getFullYear();
  const isCrossYear = year !== now.getFullYear();
  const monthName = new Intl.DateTimeFormat(locale, { month: "long" }).format(d);

  const result: {
    yearNumber?: number;
    monthNumber: number;
    monthName: string;
    day: number;
  } = { monthNumber, monthName, day: d.getDate() };

  if (isCrossYear) result.yearNumber = year;

  return result;
}

/**
 * Slice time-of-day in the viewer's current (browser) timezone.
 * Returns raw numbers for the NumberTicker-based SliceTimeMarker.
 */
export function formatSliceTime(start: string): { hour: number; minute: number } {
  const d = new Date(start);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

// ─── Main component ──────────────────────────────────────────────────────

interface TimeSliceRowProps {
  slice: SliceSummary;
}

export function TimeSliceRow({ slice }: TimeSliceRowProps) {
  const t = useTranslations("timeline.row");
  const [expandedTurns, setExpandedTurns] = useState(false);
  const [expandedMeta, setExpandedMeta] = useState(false);
  const [content, setContent] = useState<SliceContent | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Normalize fields that may come from JSON as non-arrays
  const openLoops: string[] = Array.isArray(slice.open_loops) ? slice.open_loops : [];
  const decisions: string[] = Array.isArray(slice.decisions) ? slice.decisions : [];

  // Auto-load content on mount so last turn is always visible
  useEffect(() => {
    let cancelled = false;
    setLoadingContent(true);
    getSliceContent(slice.slice_id)
      .then((data) => { if (!cancelled) setContent(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingContent(false); });
    return () => { cancelled = true; };
  }, [slice.slice_id]);

  const handleToggleTurns = () => setExpandedTurns(!expandedTurns);
  const handleToggleMeta = () => setExpandedMeta(!expandedMeta);

  const allTurns = content?.turns ?? [];
  // Default: show first exchange (user + agent pair), expand downward for the rest
  const firstExchange = allTurns.slice(0, 2);
  const laterTurns = allTurns.slice(2);
  const hasMore = laterTurns.length > 0;

  return (
    <div className="py-1">
      <div className="opacity-80">
        {/* Loading */}
        {loadingContent && (
          <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("loading")}
          </div>
        )}

        {/* First exchange — always visible (user message + agent reply) */}
        {!loadingContent && firstExchange.length > 0 &&
          firstExchange.map((t, i) => (
            <MemoryTurn key={i} content={t.content} role={t.role} />
          ))
        }

        {/* Later turns — appear below when expanded */}
        {expandedTurns && !loadingContent && laterTurns.length > 0 &&
          laterTurns.map((t, i) => (
            <MemoryTurn key={i} content={t.content} role={t.role} />
          ))
        }

        {/* "查看更多" — at bottom, below the first exchange; expands downward */}
        {!loadingContent && hasMore && (
          <button
            onClick={handleToggleTurns}
            className="w-full text-center py-1 text-[0.65rem] text-muted-foreground hover:text-muted-foreground transition-colors"
          >
            {expandedTurns ? (
              <span className="inline-flex items-center gap-1">
                <ChevronUp className="h-3 w-3" />
                {t("collapse")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ChevronDown className="h-3 w-3" />
                {t("viewMore")}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Summary caption — at bottom */}
      {slice.summary && (
        <p className="text-[0.7rem] text-muted-foreground italic mt-0.5 leading-relaxed">
          {slice.summary}
        </p>
      )}

      {/* Open loops + Decisions: counts collapsed, full pills expanded */}
      {!expandedMeta && (slice.open_loops.length > 0 || slice.decisions.length > 0) && (
        <button
          onClick={handleToggleMeta}
          className="text-[0.65rem] text-muted-foreground hover:text-muted-foreground transition-colors mt-0.5"
        >
          {openLoops.length > 0 && `↗ ${t("ongoing", { count: openLoops.length })}`}
          {openLoops.length > 0 && decisions.length > 0 && " · "}
          {decisions.length > 0 && `✓ ${t("decided", { count: decisions.length })}`}
          <ChevronRight className="h-2.5 w-2.5 inline ml-0.5" />
        </button>
      )}

      {expandedMeta && openLoops.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {openLoops.map((loop, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[0.6rem] text-muted-foreground">
              <span className="text-[0.55rem] opacity-60">↗</span>
              {loop}
            </span>
          ))}
        </div>
      )}

      {expandedMeta && decisions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {decisions.map((d, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[0.6rem] text-muted-foreground">
              <span className="text-[0.55rem] opacity-60">✓</span>
              {d}
            </span>
          ))}
        </div>
      )}

      {expandedMeta && (openLoops.length > 0 || decisions.length > 0) && (
        <button
          onClick={handleToggleMeta}
          className="text-[0.6rem] text-muted-foreground hover:text-muted-foreground transition-colors mt-0.5"
        >
          <ChevronUp className="h-2.5 w-2.5 inline mr-0.5" />
          {t("collapseMeta")}
        </button>
      )}
    </div>
  );
}
