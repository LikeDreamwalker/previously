"use client";

/**
 * FrameCard (Rev 10) — the big film-frame card face for the R3F card field.
 * One face at every zoom level: the top card of a stack is ALWAYS the full
 * original slice card (no summaries, no compaction), whether it sits alone or
 * heads a pile.
 *
 * Layout (all sizes in em, root font-size derives from cardW, so the face
 * scales with the responsive geometry tiers):
 *   corner index (strand square + the slice's FULL original timestamp via
 *   TimeDisplay — the card never truncates its time to the zoom level)
 *   → serif focus title
 *   → the slice's conversation rendered as chat bubbles (real turn content,
 *     truncated with a bottom fade — a frame of the film, not a synopsis)
 *   → tone margin note + strand squares.
 * Paper feel: noise grain + top light falloff + hairline frame + strand spine.
 */
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { Turn } from "@/lib/episodic/types";
import { TimeDisplay } from "@/components/chat/time-display";
import { strandColor, STRANDLESS_GREY } from "@/lib/timeline3d/layout";
import type { FrameGeometry, StackRow } from "@/lib/timeline3d/stacks";
import { ColorSquare, hhmm } from "./cards";
import { useSliceTurns } from "./slice-content";

/** Translated strings, passed in from OUTSIDE the R3F Canvas — drei Html
 *  renders in the Canvas's own React root, so next-intl context does not
 *  reach components rendered here (no hooks allowed inside). */
export interface FrameCardTexts {
  /** "N 轮" / "N turns". */
  turns(count: number): string;
  user: string;
  agent: string;
}

/** "HH:MM" already lives in cards.tsx; group label format matches the DOM
 *  fallback cards so e2e aria-labels stay identical. */
function groupLabel(row: StackRow, locale: string): string {
  const d = row.top.date;
  if (row.level === 2) return d.slice(0, 7).replace("-", "/");
  const date = new Date(`${d}T12:00:00`);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
    date,
  );
  return `${d.slice(5, 10).replace("-", "/")} ${weekday}`;
}

const NOISE_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E\")";

function accentOf(entry: TimelineSliceEntry): string {
  return entry.strands.length > 0
    ? strandColor(entry.strands[0])
    : STRANDLESS_GREY;
}

/** The bubbles: real turns, chat-style. User right/primary, agent left/muted. */
function TurnBubbles({
  turns,
  state,
  em,
  texts,
}: {
  turns: Turn[] | undefined;
  state: "loading" | "ready" | "failed";
  em: number;
  texts: FrameCardTexts;
}) {
  if (state === "loading") {
    return (
      <div className="flex flex-col gap-[0.55em] pt-[0.2em]" aria-hidden>
        <div className="h-[2.45em] w-[78%] animate-pulse rounded-[0.9em] rounded-bl-[0.2em] bg-muted" />
        <div className="ml-auto h-[2.05em] w-[62%] animate-pulse rounded-[0.9em] rounded-br-[0.2em] bg-primary/25" />
        <div className="h-[2.7em] w-[82%] animate-pulse rounded-[0.9em] rounded-bl-[0.2em] bg-muted" />
        <div className="ml-auto h-[1.95em] w-[55%] animate-pulse rounded-[0.9em] rounded-br-[0.2em] bg-primary/25" />
        <div className="h-[2.35em] w-[70%] animate-pulse rounded-[0.9em] rounded-bl-[0.2em] bg-muted" />
      </div>
    );
  }
  if (state === "failed" || !turns || turns.length === 0) return null;
  const shown = turns.slice(0, 6);
  return (
    <div className="flex flex-col gap-[0.55em] pt-[0.2em]">
      {shown.map((turn, i) => {
        const isUser = turn.role === "user";
        return (
          <div
            key={`${turn.turnId ?? "t"}-${i}`}
            className={`max-w-[86%] rounded-[0.9em] px-[0.85em] py-[0.6em] leading-relaxed ${
              isUser
                ? "ml-auto rounded-br-[0.2em] bg-primary text-primary-foreground"
                : "rounded-bl-[0.2em] bg-muted text-foreground/85"
            }`}
            style={{ fontSize: em * 0.72 }}
          >
            <span className="sr-only">{isUser ? texts.user : texts.agent}</span>
            <span className="line-clamp-3 whitespace-pre-wrap break-words">
              {turn.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface FrameCardProps {
  entry: TimelineSliceEntry;
  geo: FrameGeometry;
  flash?: boolean;
  /** Turn content for the bubbles; undefined while loading. */
  turns?: Turn[];
  turnsState: "loading" | "ready" | "failed";
  texts: FrameCardTexts;
}

export function FrameCard({
  entry,
  geo,
  flash,
  turns,
  turnsState,
  texts,
}: FrameCardProps) {
  const accent = accentOf(entry);
  const dry = !entry.focus;
  // Root em: the whole face scales off the card width (tiers in stacks.ts).
  const em = geo.cardW / 26;
  return (
    <div
      className={`relative block overflow-hidden rounded-[0.9em] bg-card text-left ring-1 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] transition-[box-shadow,ring-color] duration-200 dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)] ${
        flash
          ? "tl-flash ring-primary/70"
          : "ring-foreground/10 group-hover:ring-foreground/25"
      }`}
      style={{ width: geo.cardW, height: geo.cardH, fontSize: em }}
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
        className="absolute inset-y-0 left-0 w-[0.14em]"
        style={{ backgroundColor: accent, opacity: 0.85 }}
      />

      <div className="relative flex h-full flex-col px-[1.15em] pb-[0.9em] pt-[0.85em]">
        {/* Corner index. The timestamp is ALWAYS the slice's original
            start, full precision — the card's face never changes with the
            zoom/aggregation level. */}
        <div className="flex items-center gap-[0.5em] font-mono text-[0.58em] leading-none tracking-[0.16em] text-muted-foreground">
          <ColorSquare color={accent} className="size-[0.5em]" />
          <TimeDisplay
            timestamp={entry.start}
            mode="full"
            className="!text-[1em]"
          />
          <span className="ml-auto flex items-center gap-[0.8em] tracking-[0.08em]">
            {entry.turn_count != null && (
              <span className="text-foreground/55">
                {texts.turns(entry.turn_count)}
              </span>
            )}
          </span>
        </div>

        {/* Title — the focus sentence, or a big date for a dry slice. */}
        <div
          className={`mt-[0.7em] line-clamp-2 font-serif leading-snug tracking-tight text-card-foreground ${
            dry ? "text-[1.35em]" : "text-[1.05em]"
          }`}
        >
          {entry.focus || `${entry.date.slice(5)} ${hhmm(entry.start)}`.trim()}
        </div>

        <div
          aria-hidden
          className="mt-[0.75em] h-px w-full bg-foreground/[0.07]"
        />

        {/* The film frame: real conversation bubbles, faded at the bottom. */}
        <div
          className="mt-[0.7em] min-h-0 flex-1 overflow-hidden"
          style={{
            maskImage:
              "linear-gradient(to bottom, black 62%, transparent 98%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, black 62%, transparent 98%)",
          }}
        >
          <TurnBubbles turns={turns} state={turnsState} em={em} texts={texts} />
          {turnsState === "ready" && (turns == null || turns.length === 0) && (
            <p className="pt-[0.2em] font-serif text-[0.78em] italic leading-relaxed text-muted-foreground/80">
              {entry.summary || "…"}
            </p>
          )}
        </div>

        {/* Tone, set like a margin note. */}
        {entry.tone && (
          <div className="mb-[0.5em] mt-[0.5em] text-right font-serif text-[0.68em] italic leading-none text-muted-foreground/85">
            {entry.tone}
          </div>
        )}

        {/* Strand squares. */}
        {entry.strands.length > 0 && (
          <div className="mt-auto flex items-center gap-[0.35em] pt-[0.4em]">
            {entry.strands.slice(0, 5).map((name) => (
              <ColorSquare
                key={name}
                color={strandColor(name)}
                className="size-[0.42em]"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Self-loading face wrapper for the 3D card field.
 *
 * Content fetching used to live in `CardField` and was passed down through a
 * `Map<string, ContentSlot>` prop; that caused the whole scene to re-render on
 * every resolve and made the field flicker while scrolling. `SliceCardFace`
 * keeps `FrameCard` a pure presentational component and moves the subscription
 * to the per-card level via `useSliceTurns`.
 */
export function SliceCardFace({
  entry,
  geo,
  flash,
  texts,
}: {
  entry: TimelineSliceEntry;
  geo: FrameGeometry;
  flash?: boolean;
  texts: FrameCardTexts;
}) {
  const content = useSliceTurns(entry.id);
  return (
    <FrameCard
      entry={entry}
      geo={geo}
      flash={flash}
      turns={content.turns}
      turnsState={content.state}
      texts={texts}
    />
  );
}

/** Accessible label for a frame card (matches the DOM fallback cards). */
export function frameCardLabel(
  row: StackRow,
  locale: string,
): { label: string; aria: string } {
  if (row.level === 0) {
    const label =
      `${row.top.date.slice(5).replace("-", "/")} ${hhmm(row.top.start)}`.trim();
    return { label, aria: label };
  }
  const label = groupLabel(row, locale);
  return { label, aria: `${label} · ${row.count}` };
}
