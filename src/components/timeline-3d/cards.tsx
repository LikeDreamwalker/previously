"use client";

/**
 * Rev 9 timeline cards (doc/design/v0.10.0 §R9.1) — the card is a FIXED-SIZE
 * playing card ("档案卡"): same face at every zoom level, in a few JS-side
 * responsive width tiers (`cardGeometryFor` — the 3D card field reads the
 * same numbers, CSS-only breakpoints can't feed WebGL).
 *
 * Face layout: corner index row (color square + date + time · turn count) →
 * serif focus title (two lines) → tone in italic serif → strand color
 * squares; a 2px strand-colored spine on the left edge. Paper feel: subtle
 * noise grain + a top light-falloff gradient + a hairline frame.
 *
 * - SliceCard: one slice per row (L0).
 * - StackCard: a day (L1) or month (L2) stack — the top card is real; the
 *   DOM shells underneath are the no-WebGL fallback.
 */
import { useLocale, useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { strandColor, STRANDLESS_GREY } from "@/lib/timeline3d/layout";
import {
  densityTier,
  shellPose,
  type CardGeometry,
  type StackRow,
} from "@/lib/timeline3d/stacks";

// ─── Shared bits ────────────────────────────────────────────────────────────

/** Sharp corner square — the site's signature punctuation mark. */
export function ColorSquare({
  color,
  className = "size-1.5",
}: {
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-[1px] ${className}`}
      style={{ backgroundColor: color }}
    />
  );
}

/** "HH:MM" local time; "" for unparseable input. */
export function hhmm(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Fallback card title when the slice is still dry: "08-17 14:02". */
function dateTimeLabel(entry: TimelineSliceEntry): string {
  return `${entry.date.slice(5)} ${hhmm(entry.start)}`.trim();
}

/** One accent per card: the first strand's color (grey when strandless). */
function accentOf(entry: TimelineSliceEntry): string {
  return entry.strands.length > 0
    ? strandColor(entry.strands[0])
    : STRANDLESS_GREY;
}

/** "08/17 周日" / "08/17 Sun" for day stacks; "2024/08" for month stacks. */
function groupLabel(row: StackRow, locale: string): string {
  const d = row.top.date;
  if (row.level === 2) return d.slice(0, 7).replace("-", "/");
  const date = new Date(`${d}T12:00:00`);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
    date,
  );
  return `${d.slice(5, 10).replace("-", "/")} ${weekday}`;
}

/** Paper grain — an SVG turbulence tile, tinted by `currentColor` at ~4%. */
const NOISE_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E\")";

// ─── The card face (one face for every level) ───────────────────────────────

function CardFace({
  entry,
  /** Corner index label: the slice's date (L0) or the group label (L1/L2). */
  label,
  geo,
  flash,
  /** Stack count badge (L1/L2). */
  count,
}: {
  entry: TimelineSliceEntry;
  label: string;
  geo: CardGeometry;
  flash?: boolean;
  count?: number;
}) {
  const t = useTranslations("timeline3d.card");
  const accent = accentOf(entry);
  const dry = !entry.focus;
  return (
    <span
      className={`relative block overflow-hidden rounded-xl bg-card text-left ring-1 transition-[box-shadow,ring-color] duration-200 ${
        flash
          ? "tl-flash ring-primary/70"
          : "ring-foreground/10 group-hover:ring-foreground/25"
      }`}
      style={{ width: geo.cardW, height: geo.cardH }}
    >
      {/* Top light falloff + paper grain. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 text-foreground opacity-[0.035] dark:opacity-[0.05]"
        style={{ backgroundImage: NOISE_URI }}
      />
      {/* The strand spine. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[2px]"
        style={{ backgroundColor: accent, opacity: 0.85 }}
      />

      <span className="relative flex h-full flex-col px-4 pb-3.5 pt-3">
        {/* Corner index. */}
        <span className="flex items-center gap-1.5 font-mono text-[10px] leading-none tracking-[0.16em] text-muted-foreground">
          <ColorSquare color={accent} />
          {label}
          <span className="ml-auto flex items-center gap-2 tracking-[0.08em]">
            {entry.turn_count != null && (
              <span className="text-foreground/55">
                {t("turns", { count: entry.turn_count })}
              </span>
            )}
            {count != null && count > 1 && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 font-semibold text-foreground/70">
                ×{count}
              </span>
            )}
          </span>
        </span>

        {/* Title — the focus sentence, or a big date for a dry slice. */}
        <span
          className={`mt-3 line-clamp-2 font-serif leading-snug tracking-tight text-card-foreground ${
            dry ? "text-[19px]" : "text-[16.5px]"
          }`}
        >
          {entry.focus || dateTimeLabel(entry)}
        </span>

        <span className="mt-auto" />

        {/* Tone, set like a margin note. */}
        {entry.tone && (
          <span className="mb-1.5 text-right font-serif text-[11.5px] italic leading-none text-muted-foreground/85">
            {entry.tone}
          </span>
        )}

        {/* Strand squares. */}
        {entry.strands.length > 0 && (
          <span className="flex items-center gap-1">
            {entry.strands.slice(0, 5).map((name) => (
              <ColorSquare key={name} color={strandColor(name)} className="size-1" />
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

// ─── L0: one slice per row ──────────────────────────────────────────────────

export function SliceCard({
  entry,
  geo,
  flash,
  onOpen,
}: {
  entry: TimelineSliceEntry;
  geo: CardGeometry;
  /** ?at= deep-link highlight. */
  flash?: boolean;
  onOpen: (sliceId: string) => void;
}) {
  return (
    <button
      onClick={() => onOpen(entry.id)}
      className="tl-card-in group relative block text-left transition-transform duration-200 motion-safe:hover:-translate-y-0.5"
      style={{ width: geo.cardW, height: geo.cardH }}
    >
      <CardFace
        entry={entry}
        label={`${entry.date.slice(5).replace("-", "/")} ${hhmm(entry.start)}`}
        geo={geo}
        flash={flash}
      />
    </button>
  );
}

// ─── L1/L2: the stack ("一沓") ──────────────────────────────────────────────

export function StackCard({
  row,
  geo,
  flash,
  /** DOM shells under the top card — the NO-WEBGL fallback pile only; the
   *  WebGL pile field renders real 3D sheets instead. */
  shells,
  onZoomIn,
}: {
  row: StackRow;
  geo: CardGeometry;
  flash?: boolean;
  shells: boolean;
  /** Click = the whole view steps one level finer, anchored on this group. */
  onZoomIn: (row: StackRow) => void;
}) {
  const locale = useLocale();
  const shellCount = densityTier(row.count);
  return (
    <button
      onClick={() => onZoomIn(row)}
      aria-label={`${groupLabel(row, locale)} · ${row.count}`}
      className="tl-card-in group relative block text-left transition-transform duration-200 motion-safe:hover:-translate-y-0.5"
      style={{ width: geo.cardW, height: geo.cardH }}
    >
      {shells &&
        Array.from({ length: shellCount }, (_, i) => {
          // Deepest shell first so the top card's neighbour paints last.
          const depth = shellCount - 1 - i;
          const pose = shellPose(row.key, depth);
          return (
            <span
              aria-hidden="true"
              key={depth}
              className="absolute top-0 bottom-0 rounded-xl bg-card ring-1 ring-foreground/15 shadow-sm"
              style={{
                left: 4 * (depth + 1),
                right: 4 * (depth + 1),
                transform: `translate(${pose.offsetX}px, ${pose.offsetY}px) rotate(${pose.rotate}deg)`,
                opacity: 0.9 - depth * 0.15,
                zIndex: 0,
              }}
            />
          );
        })}
      <span className="relative z-[1] block">
        <CardFace
          entry={row.top}
          label={groupLabel(row, locale)}
          geo={geo}
          flash={flash}
          count={row.count}
        />
      </span>
    </button>
  );
}
