"use client";

/**
 * ReadingPanel (Rev 7 §R7.3) — the hour level's reading surface: focusing a
 * slice slides a full-height dock in from the right edge carrying the
 * slice's complete turn flow ("线的横截面"). Plain DOM OUTSIDE the R3F
 * Canvas, so next-intl context and native scroll/selection just work.
 * Desktop docks right (~420px); phones get a bottom sheet (the design's
 * mobile refinement, done cheaply with responsive classes).
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { SliceContent } from "@/lib/episodic/actions";
import { strandColor, STRANDLESS_GREY } from "@/lib/timeline3d/layout";
import { TurnsSkeleton } from "./turns-skeleton";

/** First line of a turn's content, for the collapsed row. */
function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i);
}

export function ReadingPanel({
  entry,
  content,
  contentState,
  onClose,
  onTraverse,
}: {
  entry: TimelineSliceEntry;
  content: SliceContent | null;
  contentState: "loading" | "ready" | "failed";
  onClose: () => void;
  onTraverse: (sliceId: string) => void;
}) {
  const t = useTranslations("timeline3d");
  const [expanded, setExpanded] = useState<number | null>(null);
  useEffect(() => setExpanded(null), [entry.id]);

  const accent =
    entry.strands.length > 0
      ? strandColor(entry.strands[0])
      : STRANDLESS_GREY;

  return (
    <aside
      className="tl-panel-in absolute inset-x-0 bottom-0 z-30 flex max-h-[62vh] flex-col overflow-hidden rounded-t-2xl border-t border-border/50 bg-background/85 backdrop-blur-xl md:inset-x-auto md:right-0 md:top-0 md:max-h-none md:w-[420px] md:rounded-none md:border-l md:border-t-0"
      role="dialog"
      aria-label={entry.focus || entry.date}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px md:inset-y-0 md:left-0 md:h-auto md:w-px"
        style={{ backgroundColor: accent, opacity: 0.55 }}
      />

      {/* Header: date + focus + close. */}
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
        <div className="min-w-0">
          <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] leading-none tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-[1px]"
              style={{ backgroundColor: accent }}
            />
            {entry.date} · {entry.start.slice(11, 16)}
          </p>
          {entry.focus && (
            <p className="font-serif text-[17px] leading-snug tracking-tight text-foreground">
              {entry.focus}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label={t("turns.close")}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {/* Summary + strands/tags. */}
      {(entry.summary ||
        entry.strands.length > 0 ||
        entry.tags.length > 0) && (
        <div className="border-b border-border/40 px-5 py-3.5">
          {entry.summary && (
            <p className="font-serif text-[13px] leading-relaxed text-foreground/80">
              {entry.summary}
            </p>
          )}
          {(entry.strands.length > 0 || entry.tags.length > 0) && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] leading-tight">
              {entry.strands.map((name) => (
                <span
                  key={`s:${name}`}
                  className="inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <span
                    aria-hidden
                    className="inline-block size-1 rounded-[1px]"
                    style={{ backgroundColor: strandColor(name) }}
                  />
                  <span className="text-muted-foreground">{name}</span>
                </span>
              ))}
              {entry.tags.map((tag) => (
                <span key={`t:${tag}`} className="text-muted-foreground/60">
                  · {tag}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {/* The full turn flow — the panel's raison d'être. */}
      <div data-tl-scroll className="flex-1 overflow-y-auto px-5 py-3">
        {contentState === "loading" && (
          <div role="status">
            <span className="sr-only">{t("turns.loading")}</span>
            <TurnsSkeleton rows={6} />
          </div>
        )}
        {contentState === "failed" && (
          <p className="py-2 text-[12px] text-muted-foreground">
            {t("turns.failed")}
          </p>
        )}
        {contentState === "ready" &&
          content?.turns.map((turn, i) => {
            const isUser = turn.role === "user";
            const open = expanded === i;
            return (
              <button
                key={`${turn.turnId ?? "turn"}-${i}`}
                onClick={() => setExpanded(open ? null : i)}
                className={`block w-full rounded-md px-2 py-2 text-left transition-colors ${
                  open ? "bg-accent" : "hover:bg-accent/60"
                }`}
              >
                <span
                  className={`mr-2 font-mono text-[10px] uppercase tracking-[0.14em] ${
                    isUser
                      ? "font-semibold text-foreground/85"
                      : "text-muted-foreground"
                  }`}
                >
                  {isUser ? t("turns.user") : t("turns.agent")}
                </span>
                <span
                  className={`text-[12.5px] leading-relaxed text-foreground/80 ${
                    open ? "whitespace-pre-wrap" : "line-clamp-3"
                  }`}
                >
                  {open ? turn.content : firstLine(turn.content)}
                </span>
              </button>
            );
          })}
      </div>

      {/* Footer: traverse into the chat at this slice. */}
      <div className="border-t border-border/60 px-5 py-3">
        <button
          onClick={() => onTraverse(entry.id)}
          className="w-full rounded-md border border-border px-3 py-2 text-[12px] font-medium transition-colors hover:bg-accent"
          style={{ color: "var(--primary)" }}
        >
          {t("turns.open")} →
        </button>
      </div>
    </aside>
  );
}
