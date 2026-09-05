"use client";

/**
 * The left time rail (v0.10 §1.3 Rev 2) — a hairline at the screen's left
 * edge with one node per TURN currently in the viewport, each node carrying
 * its timestamp in rolling digits (the timeline-wheel animation, shared via
 * rolling-number.tsx). Purely transient and presentational: it fades in
 * while scrolling and out ~1s after the scroll stops, never takes layout
 * space, and offers no slice-level jumping (that's the timeline mode's job).
 * Desktop only — mobile keeps the floating StreamTimeIndicator.
 */
import { useLocale, useTranslations } from "next-intl";
import type { RailNode } from "@/lib/chat/time-rail";
import { RollingField } from "./rolling-number";
import { formatSeamDate } from "./slice-seam";
import { sameDay } from "./time-display";

/** One node's timestamp: HH:MM in rolling digits, prefixed by a small static
 *  date once it crosses a day boundary (the indicator's label rule, §1.3). */
function RailTimestamp({ iso, locale }: { iso: string; locale: string }) {
  const d = new Date(iso);
  return (
    <span className="ml-1.5 flex items-baseline gap-1 font-mono text-[0.6rem] leading-none tabular-nums text-muted-foreground/80">
      {!sameDay(iso) && (
        <span className="text-muted-foreground/60">
          {formatSeamDate(iso, locale)}
        </span>
      )}
      <span className="inline-flex items-baseline">
        <RollingField value={d.getHours()} />
        <span>:</span>
        <RollingField value={d.getMinutes()} />
      </span>
    </span>
  );
}

export function StreamTimeRail({
  nodes,
  visible,
  /** The scroller viewport's window coords — the rail is `fixed` at the
   *  screen's left edge but spans exactly the stream's viewport. */
  top,
  height,
}: {
  nodes: RailNode[];
  visible: boolean;
  top: number;
  height: number;
}) {
  const t = useTranslations("chat.rail");
  const locale = useLocale();

  return (
    <div
      role="presentation"
      aria-label={t("label")}
      aria-hidden={!visible}
      style={{ top, height }}
      className={`pointer-events-none fixed left-2 z-10 w-24 transition-opacity duration-300 ${
        visible && nodes.length > 0 ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* The hairline. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-px bg-border/60"
      />
      {nodes.map((node) => (
        <div
          key={node.key}
          className="absolute left-0 flex items-center"
          style={{ top: node.y, transform: "translateY(-50%)" }}
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 -translate-x-[2.5px] rounded-full bg-muted-foreground/70"
          />
          <RailTimestamp iso={node.timeIso} locale={locale} />
        </div>
      ))}
    </div>
  );
}
