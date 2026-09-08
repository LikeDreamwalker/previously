"use client";

/**
 * FrameCard (Rev 11) — the dossier / specimen card face for the R3F card field.
 * One face at every zoom level: the top card of a stack is ALWAYS the full
 * original slice card (no summaries, no compaction), whether it sits alone or
 * heads a pile.
 *
 * Layout (all sizes in em; root font-size derives from the card's short edge,
 * so the face scales with the responsive geometry tiers without blowing up
 * in landscape):
 *   time code (strand square + FULL timestamp · duration · turn count ·
 *   decorative archive number)
 *   → serif focus title
 *   → previously line (book quotes)
 *   → ledger-style archive rows (TONE / DECIDED / OPEN / STRANDS)
 *   → chat bubbles (real turns, agent serif, user sans)
 *   → footer (continued-from + FR.date)
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
  /** "47 分钟" / "47 MIN". */
  duration(min: number): string;
  /** "No.0808·0208" style archive stamp. */
  no(date: string, time: string): string;
  tone: string;
  decided: string;
  open: string;
  strands: string;
  /** "、" / "; ". */
  listSeparator: string;
  /** "续自 {{date}}" / "cont. {{date}}". */
  continuedFrom(date: string): string;
  /** "FR.{{date}}". */
  fr(date: string): string;
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

function durationMin(start: string, end?: string): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms)) return null;
  const min = Math.round(ms / 60000);
  return min > 0 ? min : null;
}

function archiveStamp(entry: TimelineSliceEntry): string {
  const datePart = `${entry.date.slice(5, 7)}${entry.date.slice(8, 10)}`;
  const timePart = hhmm(entry.start).replace(":", "");
  return `${datePart}·${timePart}`;
}

function continuedDate(id: string | undefined): string | null {
  if (!id) return null;
  return `${id.slice(5, 7)}/${id.slice(8, 10)}`;
}

/** Strip markdown noise out of a previously.md snapshot so the card shows
 *  a readable prose sentence instead of headings, metadata pipes and bullets. */
function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/(^|\s)_([^_]+)_(\s|$)/g, "$1$2$3")
    .replace(/[*`#]/g, "")
    .trim();
}

/** Extract a readable prose sentence from a previously.md snapshot.
 *  Keeps the cache untouched; this is display-layer cleanup only. */
function previouslyExcerpt(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Remove italic-wrapped metadata blocks (the "_Active slice: ... | Updated: ..._" line).
  let text = raw.replace(
    /_[\s\S]*?(?:Active slice|Format|Updated|updated):[\s\S]*?_/g,
    " ",
  );

  // Strip a leading heading marker but keep the rest of the line so inline
  // markdown like "# Previously On - User is..." still yields prose.
  text = text.replace(/^#+\s+/, "");

  // Split inline headings and bullets into separate lines.
  text = text
    .replace(/\s*#{2,}\s*[^#\n]+\s*/g, "\n")
    .replace(/\s*-\s+/g, "\n");

  // Clean residual inline markdown.
  text = cleanInlineMarkdown(text);

  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const isMetadata = (l: string) =>
    /^(Active slice:|Format:|Updated:|updated:)/.test(l);

  // Prefer the first non-bullet, non-metadata narrative line that's long enough
  // to be real prose (not a short heading like "User profile").
  let prose: string | undefined =
    lines.find(
      (l) => !isMetadata(l) && !/^[-*]/.test(l) && l.length > 20,
    ) ||
    lines.find((l) => !isMetadata(l) && !/^[-*]/.test(l));

  if (!prose) {
    const first = lines.find((l) => !isMetadata(l));
    prose = first ? first.replace(/^[-*]\s+/, "").trim() : undefined;
  }

  if (!prose || prose.length === 0) return null;

  if (prose.length <= 160) return prose;
  const cut = prose.slice(0, 160).lastIndexOf(" ");
  return prose.slice(0, cut > 0 ? cut : 160) + "…";
}

/** 1px hairline with the card's muted foreground tint. */
function Hairline({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`h-px w-full bg-foreground/[0.07] ${className}`}
    />
  );
}

/** A single ledger row: fixed-width uppercase key + serif value. */
function LedgerRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-[0.6em] py-[0.5em]">
      <span className="w-[5.5em] shrink-0 font-sans text-[0.58em] uppercase leading-[1.45] tracking-[0.12em] text-muted-foreground/75">
        {label}
      </span>
      <span className="min-w-0 flex-1 font-sans text-[0.72em] leading-[1.45] text-foreground/90">
        {value}
      </span>
    </div>
  );
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
            <span
              className="line-clamp-3 whitespace-pre-wrap break-words font-serif font-light"
            >
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
  /** Previously.md snapshot, if any. */
  previously?: string | null;
  texts: FrameCardTexts;
}

export function FrameCard({
  entry,
  geo,
  flash,
  turns,
  turnsState,
  previously,
  texts,
}: FrameCardProps) {
  const accent = accentOf(entry);
  const dry = !entry.focus;
  // Root em scales off the short edge so type stays consistent across the
  // responsive landscape and portrait geometry tiers.
  const landscape = geo.cardW > geo.cardH;
  const em = landscape ? geo.cardH / 26 : geo.cardW / 26;

  const minutes = durationMin(entry.start, entry.end);
  const stamp = archiveStamp(entry);
  const contDate = continuedDate(entry.continues_from);
  const dateClean = entry.date.replace(/-/g, "");

  const decided = entry.decisions.slice(0, 2);
  const open = entry.open_loops.slice(0, 2);
  const strands = entry.strands.slice(0, 4);
  const previouslyText = previouslyExcerpt(previously);

  const ledgerRows: { key: string; value: React.ReactNode }[] = [];
  if (entry.tone) {
    ledgerRows.push({ key: texts.tone, value: entry.tone });
  }
  if (decided.length > 0) {
    ledgerRows.push({
      key: texts.decided,
      value: decided.join(texts.listSeparator),
    });
  }
  if (open.length > 0) {
    ledgerRows.push({
      key: texts.open,
      value: open.join(texts.listSeparator),
    });
  }
  if (strands.length > 0) {
    ledgerRows.push({
      key: texts.strands,
      value: (
        <span className="flex flex-wrap items-center gap-x-[0.5em] gap-y-[0.25em]">
          {strands.map((name) => (
            <span key={name} className="inline-flex items-center gap-[0.3em]">
              <ColorSquare
                color={strandColor(name)}
                className="size-[0.42em]"
              />
              <span>{name}</span>
            </span>
          ))}
        </span>
      ),
    });
  }

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

      <div className="relative flex h-full flex-col px-[1.15em] pb-[0.85em] pt-[0.8em]">
        {/* Time code row. The timestamp is ALWAYS the slice's original
            start, full precision — the card's face never changes with the
            zoom/aggregation level. */}
        <div className="flex items-center gap-[0.5em] font-serif text-[0.62em] leading-none tracking-[0.08em] text-muted-foreground">
          <ColorSquare color={accent} className="size-[0.5em]" />
          <TimeDisplay
            timestamp={entry.start}
            mode="full"
            className="!font-serif !text-[1em]"
          />
          <span className="ml-auto flex items-center gap-[0.8em] font-sans lining-nums tracking-[0.08em]">
            {minutes != null && (
              <span className="text-foreground/55">· {texts.duration(minutes)}</span>
            )}
            {entry.turn_count != null && (
              <span className="text-foreground/55">
                {texts.turns(entry.turn_count)}
              </span>
            )}
            {landscape && (
              <span className="font-mono text-foreground/40">{texts.no(stamp.slice(0, 4), stamp.slice(5))}</span>
            )}
          </span>
        </div>

        <Hairline className="mt-[0.65em]" />

        {/* Title — the focus sentence, or a big date for a dry slice. */}
        <div
          className={`mt-[0.6em] line-clamp-2 font-serif leading-snug tracking-tight text-card-foreground ${
            dry ? "text-[1.35em]" : "text-[1.08em]"
          }`}
        >
          {entry.focus || `${entry.date.slice(5)} ${hhmm(entry.start)}`.trim()}
        </div>

        {/* Previously — book-quoted italic serif. */}
        {previouslyText && (
          <>
            <Hairline className="mt-[0.65em]" />
            <p className="mt-[0.55em] line-clamp-2 font-serif text-[0.74em] font-light italic leading-relaxed text-muted-foreground/85">
              <span className="text-foreground/40">❝ </span>
              {previouslyText}
              <span className="text-foreground/40"> ❞</span>
            </p>
          </>
        )}

        {/* Ledger-style archive rows. */}
        {ledgerRows.length > 0 && (
          <>
            <Hairline className="mt-[0.65em]" />
            <div className="flex flex-col">
              {ledgerRows.map((row, i) => (
                <div key={row.key}>
                  {i > 0 && <Hairline />}
                  <LedgerRow label={row.key} value={row.value} />
                </div>
              ))}
            </div>
          </>
        )}

        <Hairline className="mt-[0.55em]" />

        {/* The film frame: real conversation bubbles, faded at the bottom. */}
        <div
          className="mx-auto mt-[0.55em] min-h-0 w-full flex-1 overflow-hidden"
          style={{
            maxWidth: "34em",
            maskImage:
              "linear-gradient(to bottom, black 62%, transparent 98%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, black 62%, transparent 98%)",
          }}
        >
          <TurnBubbles turns={turns} state={turnsState} em={em} texts={texts} />
          {turnsState === "ready" && (turns == null || turns.length === 0) && (
            <p className="pt-[0.2em] font-serif text-[0.78em] font-light italic leading-relaxed text-muted-foreground/80">
              {entry.summary || "…"}
            </p>
          )}
        </div>

        {/* Footer. */}
        <Hairline className="mt-[0.55em]" />
        <div className="mt-[0.45em] flex items-center justify-between font-sans lining-nums text-[0.55em] leading-none tracking-[0.1em] text-muted-foreground/70">
          {contDate ? (
            <span>↳ {texts.continuedFrom(contDate)}</span>
          ) : (
            <span />
          )}
          <span className="font-mono">{texts.fr(dateClean)}</span>
        </div>
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
      previously={content.previously}
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
