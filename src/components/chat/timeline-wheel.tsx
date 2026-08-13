"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { getTimelineCatalog } from "@/lib/episodic/actions";

// ─── Constants ──────────────────────────────────────────────────────────

/** Row height in px — also the center selection band's height. */
const ROW_H = 56;
/** Extra rows rendered above/below the viewport (virtualization margin). */
const RENDER_MARGIN = 6;
/** Distance from center at which a row reaches its smallest scale / lowest opacity. */
const FADE_PX = ROW_H * 2.4;

interface TimelineWheelProps {
  /** The currently LOADED slice — the one whose content the right side shows.
   *  Its row carries the blue selection mark; the wheel's focused row (scroll
   *  preview) is deliberately NOT blue. */
  selectedId: string | null;
  /** The slice the user just clicked but whose transition hasn't landed yet —
   *  lights the selection glow IMMEDIATELY so it never lags the click by the
   *  roll's duration. Cleared by the parent when the transition lands. */
  pendingId?: string | null;
  /** `start` is the target slice's start ISO — lets the parent run the
   *  time-travel clock from where the viewer currently is to the target. */
  onSelect: (sliceId: string, start?: string) => void;
}

interface WheelItem {
  id: string;
  start: string;
  focus: string;
  isNow: boolean;
}

// ─── Internal responsive switch ─────────────────────────────────────────
// The wheel decides its own gear (mobile lock-screen clock vs desktop
// sidebar) instead of receiving `narrow`/`compact` props from the parent.
// matchMedia is consulted in a layout effect so a phone flips to the narrow
// form BEFORE the first paint (the SSR first render stays desktop so
// hydration matches). The threshold mirrors Tailwind's `md:` breakpoint —
// the few responsive class swaps below (`md:left-1.5`, `md:justify-start`)
// rely on that.

function useIsMobile(): boolean {
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

// ─── Plain local-time formatting ────────────────────────────────────────
// Rows render these directly — NOT TimeDisplay (whose NumberTicker starts
// digits at `value - 30` and only animates in view, so offscreen virtualized
// rows show e.g. "1996" for years). The rolling-digit effect belongs to the
// central readout only.

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${mo}/${day}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${mi}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** MM/DD only — the narrow (mobile) clock drops the year. */
function formatMD(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

// ─── Timestamp tones ────────────────────────────────────────────────────
// Two emphasis levels shared by every timestamp variant: the primary line
// (hour / time) reads stronger, the secondary line (date) reads muted.
// Selected = brand blue; otherwise muted with a hover lift (the row button
// is the `group`).

function accentCls(isSelected: boolean): string {
  return isSelected
    ? "text-brand-600 dark:text-brand-400"
    : "text-foreground/70 group-hover:text-foreground";
}

function mutedCls(isSelected: boolean): string {
  return isSelected
    ? "text-brand-600 dark:text-brand-400"
    : "text-muted-foreground/60 group-hover:text-foreground/80";
}

/** The soft brand stage-light behind a timestamp — lit when its slice is
 *  loaded (or clicked-pending), a fainter version on hover. */
function RowGlow({ isSelected, className }: { isSelected: boolean; className: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute -z-10 transition-opacity duration-200 ${
        isSelected
          ? "bg-brand-500/15 opacity-100"
          : "bg-brand-500/8 opacity-0 group-hover:opacity-100"
      } ${className}`}
    />
  );
}

/**
 * The lock-screen clock — the narrow (mobile) timestamp. Small MM/DD over big
 * hour and minute, year dropped. Everything is tabular monospace so the three
 * lines share one width: "MM/DD" is 5 glyphs at 0.6rem and "HH"/"MM" are 2
 * glyphs at text-2xl, which come out the same in a mono face — the digits line
 * up as a clean column, lock-screen style.
 */
function LockClock({ timestamp, isSelected }: { timestamp: string; isSelected: boolean }) {
  const d = new Date(timestamp);
  const valid = !isNaN(d.getTime());
  const hour = valid ? pad2(d.getHours()) : "00";
  const minute = valid ? pad2(d.getMinutes()) : "00";
  const date = valid ? formatMD(timestamp) : "00/00";
  return (
    <>
      <span className={`font-mono text-[0.6rem] leading-none tabular-nums transition-colors ${mutedCls(isSelected)}`}>
        {date}
      </span>
      <span className={`font-mono text-2xl leading-none tabular-nums transition-colors ${accentCls(isSelected)}`}>{hour}</span>
      <span className={`font-mono text-2xl leading-none tabular-nums transition-colors ${accentCls(isSelected)}`}>{minute}</span>
    </>
  );
}

// ─── Rolling digit — the "reverse tick" ──────────────────────────────────

/**
 * A single digit that rolls (odometer-style) to a new value whenever it
 * changes, counting through the intermediate integers. Scrolling into the
 * past moves targets downward → digits count down; forward → count up.
 * Tweens from the *currently displayed* value so rapid scrolls retarget
 * smoothly instead of jumping.
 */
function useRollingNumber(target: number): number {
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

function RollingDigit({ value }: { value: number }) {
  const display = useRollingNumber(value);
  return (
    <span className="inline-block w-[0.62em] text-center tabular-nums">
      {display}
    </span>
  );
}

/** A zero-padded numeric field (year, month, day, …) whose digits roll. */
function RollingField({ value, digits = 2 }: { value: number; digits?: number }) {
  const str = String(value).padStart(digits, "0");
  return (
    <span className="inline-flex">
      {str.split("").map((ch, i) => (
        <RollingDigit key={i} value={Number(ch)} />
      ))}
    </span>
  );
}

/** The central readout — a rolling HH:MM (the rows carry the full date, so
 *  the readout stays slim). */
function RollingTime({ timestamp }: { timestamp: string }) {
  const d = new Date(timestamp);
  const h = d.getHours();
  const mi = d.getMinutes();

  return (
    <span className="inline-flex items-baseline font-mono leading-none">
      <RollingField value={h} digits={2} />
      <span className="mx-0.5 text-muted-foreground/60">:</span>
      <RollingField value={mi} digits={2} />
    </span>
  );
}

// ─── The per-slice timestamp ────────────────────────────────────────────

/**
 * The ONLY part of the wheel that differs between the two gears. Narrow
 * (mobile): a lock-screen clock straddling the centered spine. Desktop: an
 * axis dot on the left spine plus a two-line date/time label to its right.
 * Same timestamp, two placements — the spine, beam, focal scale, scroll and
 * selection logic are all ONE shared code path; this component is the entire
 * responsive surface.
 *
 * The narrow clock rides on a patch of FOG — the desktop's brand glow shape
 * rendered in the panel's own background color instead of blue: the spine
 * dissolves into the mist behind the glyphs instead of striking through
 * them. Because the fog's edges are soft, it masks gracefully at ANY opacity,
 * so the whole row takes the focal fade — no decoupling needed. On mobile the
 * fog REPLACES the glow (selected = brand-colored digits + the spine beam's
 * peak); the desktop label keeps the blue glow as its selection light.
 */
function RowTimestamp({
  item,
  isSelected,
  narrow,
  nowLabel,
}: {
  item: WheelItem;
  isSelected: boolean;
  narrow: boolean;
  nowLabel: string;
}) {
  if (narrow) {
    return (
      <span className="relative flex flex-col items-center px-1 py-1">
        {/* The fog — same footprint as the desktop glow, bg-colored. Above the
            spine, below the glyphs. */}
        <span aria-hidden className="absolute -inset-x-1 -inset-y-1.5 rounded-2xl bg-background blur-md" />
        <span className="relative flex flex-col items-center gap-1">
          {item.isNow ? (
            <span
              className={`font-mono text-base leading-none tracking-wider transition-colors ${mutedCls(isSelected)}`}
            >
              {nowLabel}
            </span>
          ) : (
            <LockClock timestamp={item.start} isSelected={isSelected} />
          )}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {/* Axis dot — sits on the left spine. */}
      <span className="flex size-3 shrink-0 items-center justify-center">
        <span
          className={`block size-2 rounded-full transition-colors ${
            isSelected
              ? "bg-brand-500 shadow-[0_0_8px_var(--brand-500)]"
              : "bg-border/60 group-hover:bg-brand-500/60"
          }`}
        />
      </span>
      {/* Two-line time (year/month/day over hh:mm), left-aligned. */}
      <span className="relative flex flex-col items-start gap-0.5">
        <RowGlow isSelected={isSelected} className="-inset-x-2 -inset-y-1.5 rounded-full blur-md" />
        <span className={`font-mono text-[0.7rem] leading-tight tabular-nums transition-colors ${mutedCls(isSelected)}`}>
          {formatDate(item.start)}
        </span>
        <span className={`font-mono text-[0.8rem] leading-tight tabular-nums transition-colors ${accentCls(isSelected)}`}>
          {item.isNow ? nowLabel : formatTime(item.start)}
        </span>
      </span>
    </span>
  );
}

/** Fake row rendered by the width sentinel — tabular-nums makes every digit
 *  the same width, so any valid timestamp measures the widest label. */
const SENTINEL_ITEM: WheelItem = {
  id: "sentinel",
  start: "2000-01-01T00:00:00",
  focus: "",
  isNow: false,
};

// ─── The wheel ──────────────────────────────────────────────────────────

export function TimelineWheel({ selectedId, pendingId, onSelect }: TimelineWheelProps) {
  const t = useTranslations("timeline");
  const nowLabel = t("panel.now");
  // Internal responsive gear: `narrow` = the mobile lock-screen-clock column.
  // The component owns the switch — the parent just renders <TimelineWheel …/>.
  // The mechanism below is identical in both gears; only the timestamp
  // (RowTimestamp), the row height and the spine's horizontal position respond
  // to it.
  const narrow = useIsMobile();

  const [items, setItems] = useState<WheelItem[] | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  // Mouse drag-to-scroll state. `moved` distinguishes a drag from a click so a
  // drag that ends over a row doesn't accidentally load it.
  const dragRef = useRef({ active: false, moved: false, startY: 0, startScroll: 0 });
  // Narrow rows are taller — the lock-screen clock (small date + big hour +
  // big minute) needs room for the spine line to show through above and below
  // each timestamp block, threading the whole column. This is a parameter of
  // the skin, not a second implementation.
  const rowH = narrow ? 96 : ROW_H;
  const fadePx = FADE_PX * (rowH / ROW_H);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !scrollRef.current) return;
    dragRef.current = {
      active: true,
      moved: false,
      startY: e.clientY,
      startScroll: scrollRef.current.scrollTop,
    };
    setDragging(true);
    // Prevent the browser's default text-selection / native drag from kicking in.
    e.preventDefault();
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const delta = e.clientY - d.startY;
    if (!d.moved && Math.abs(delta) > 3) d.moved = true;
    // Content follows the drag (mobile-style): drag down moves the content
    // down → reveal earlier (past) frames; drag up → toward now.
    if (scrollRef.current) scrollRef.current.scrollTop = d.startScroll - delta;
  };

  // End the drag on a window-level mouseup so releasing outside the container
  // still stops cleanly (and on window blur, e.g. alt-tab mid-drag).
  useEffect(() => {
    if (!dragging) return;
    const end = () => {
      dragRef.current.active = false;
      setDragging(false);
    };
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", end);
    };
  }, [dragging]);

  // A drag that ends on a row would fire its onClick on mouseup — swallow it.
  const handleClickCapture = (e: React.MouseEvent) => {
    if (dragRef.current.moved) {
      e.stopPropagation();
      dragRef.current.moved = false;
    }
  };

  // Load the catalog (oldest → newest) + a "now" sentinel at the bottom.
  useEffect(() => {
    let cancelled = false;
    getTimelineCatalog()
      .then((slices) => {
        if (cancelled) return;
        const rows: WheelItem[] = slices.map((s) => ({
          id: s.id,
          start: s.start,
          focus: s.focus || s.summary,
          isNow: false,
        }));
        rows.push({ id: "now", start: new Date().toISOString(), focus: "", isNow: true });
        setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Measure the container height (for center math) and keep it in sync.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initial position: center "now" (the bottom sentinel) so the app opens on
  // the present, and the user scrolls *up* into the past.
  useEffect(() => {
    if (!items || !scrollRef.current || height === 0) return;
    const el = scrollRef.current;
    // Center the "now" sentinel (the last row). With the symmetric padding this
    // equals the max scrollTop, so the wheel opens on the present.
    const target = Math.max(0, (items.length - 1) * rowH);
    el.scrollTop = target;
    setScrollTop(el.scrollTop);
  }, [items, height, rowH]);

  // rAF-throttled scroll position.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(el.scrollTop);
    });
  };

  const centerY = scrollTop + height / 2;
  // Symmetric top/bottom padding so the first and last rows can BOTH reach the
  // selection band at the vertical center — the wheel's two ends aren't dead.
  const pad = Math.max(0, height / 2 - rowH / 2);
  const totalPx = items ? items.length * rowH + pad * 2 : 0;

  // Virtualized + focal-transform view of the visible rows.
  const visibleRows = useMemo(() => {
    if (!items || items.length === 0) return [];
    const start = Math.max(0, Math.floor((scrollTop - pad) / rowH) - RENDER_MARGIN);
    const end = Math.min(items.length, Math.ceil((scrollTop + height - pad) / rowH) + RENDER_MARGIN);
    const rows: Array<{ index: number; item: WheelItem; scale: number; opacity: number }> = [];
    for (let i = start; i < end; i++) {
      const item = items[i];
      const rowCenter = pad + i * rowH + rowH / 2;
      const dist = Math.abs(rowCenter - centerY);
      const tt = Math.min(1, dist / fadePx);
      rows.push({
        index: i,
        item,
        scale: 1 - tt * 0.32,
        opacity: 1 - tt * 0.7,
      });
    }
    return rows;
  }, [items, scrollTop, height, centerY, pad, rowH, fadePx]);

  // The row nearest the selection band — drives the readout only. Content is
  // loaded on EXPLICIT click, not on scroll-settle, so browsing costs zero
  // requests (slice reads are GitHub API calls in production).
  const focusedIndex = useMemo(() => {
    if (!items || items.length === 0) return 0;
    const idx = Math.round((centerY - pad - rowH / 2) / rowH);
    return Math.max(0, Math.min(items.length - 1, idx));
  }, [items, centerY, pad, rowH]);
  const focused = items ? items[focusedIndex] : null;

  // The lit slice — the LOADED one (or a pending click, so the light moves the
  // instant the user clicks, like the blue dot). It lights the axis spine below.
  const litIndex = useMemo(() => {
    if (!items) return -1;
    return items.findIndex((i) => i.id === selectedId || i.id === pendingId);
  }, [items, selectedId, pendingId]);

  // The spine's background — a brand-blue light that peaks at the lit slice's
  // current viewport position and fades out above and below it, like a beam.
  const spineBackground = useMemo(() => {
    if (litIndex === -1 || height === 0) {
      // No selection yet — a uniform translucent brand line.
      return "oklch(from var(--brand-500) l c h / 0.18)";
    }
    const center = pad + litIndex * rowH + rowH / 2 - scrollTop;
    const peak = Math.max(0, Math.min(100, (center / height) * 100));
    const s = 18;
    const lo = Math.max(0, peak - s);
    const hi = Math.min(100, peak + s);
    return `linear-gradient(to bottom,
      oklch(from var(--brand-500) l c h / 0.05) 0%,
      oklch(from var(--brand-500) l c h / 0.22) ${lo}%,
      oklch(from var(--brand-500) l c h / 0.65) ${peak}%,
      oklch(from var(--brand-500) l c h / 0.22) ${hi}%,
      oklch(from var(--brand-500) l c h / 0.05) 100%)`;
  }, [litIndex, height, scrollTop, pad, rowH]);

  const centerOn = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // Rows sit at `pad + i*rowH + rowH/2` — the pad must be included so the
    // clicked row lands exactly on the selection band.
    const target = Math.max(0, pad + index * rowH + rowH / 2 - height / 2);
    el.scrollTo({ top: target, behavior: "smooth" });
  };

  return (
    <div className="relative h-full">
      {/* ONE spine for both gears — the same brand-blue beam, brightest at the
          lit slice. Only its horizontal position is responsive: centered on
          mobile (the clocks straddle it), left edge on desktop (the dots sit
          on it). Drawn OUTSIDE the scroll container so it never moves while
          the timestamps scroll past it (time is continuous). */}
      <div
        className="pointer-events-none absolute inset-y-0 left-1/2 z-0 w-px -translate-x-1/2 md:left-1.5"
        style={{ background: spineBackground }}
      />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onClickCapture={handleClickCapture}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Timeline wheel"
        className={`relative z-10 h-full select-none overflow-y-auto overflow-x-hidden scrollbar-none ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
      {/* Invisible width sentinel: every row is absolutely positioned, so on
          their own they give the panel zero intrinsic width. This hidden copy
          of the widest timestamp defines the collapsed panel's natural width —
          the split measures it and the column shrinks to fit the content
          instead of a fixed 180px. Desktop keeps a trailing padding for the
          selected row's brand glow so its soft edge fades before the panel
          cuts it off; mobile needs none — the fog is background-colored, so
          clipping it is invisible, and the column stays tight to the clocks. */}
      <div
        aria-hidden
        className={`w-max ${narrow ? "px-1" : "pr-4"}`}
        style={{ height: 0, visibility: "hidden" }}
      >
        <RowTimestamp item={SENTINEL_ITEM} isSelected={false} narrow={narrow} nowLabel={nowLabel} />
      </div>

      {!items ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ── Virtualized rows ── */}
          <div className="relative" style={{ height: totalPx }}>
            {visibleRows.map(({ index, item, scale, opacity }) => {
              // Blue = the LOADED slice (whose content is shown on the right),
              // OR the slice the user just clicked while its transition is
              // still rolling (pendingId) — so the glow lights instantly.
              // It does NOT follow scroll previews — only an explicit click
              // moves it.
              const isSelected = item.isNow
                ? selectedId === "now" || pendingId === "now"
                : selectedId === item.id || pendingId === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelect(item.id, item.start);
                    centerOn(index);
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  // justify-center ↔ md:justify-start is the row's only layout
                  // response to the gear (`md:` mirrors the useIsMobile threshold).
                  className="group absolute inset-x-0 flex cursor-pointer items-center justify-center md:justify-start md:pr-2"
                  style={{
                    // ONE geometry for both gears: content centered on the row
                    // line, then focal-scaled and focal-faded. Mobile scales
                    // from its center; desktop scales toward the spine so the
                    // dots stay on it.
                    top: pad + index * rowH + rowH / 2,
                    transform: `translateY(-50%) scale(${scale})`,
                    transformOrigin: narrow ? "center center" : "left center",
                    opacity,
                    zIndex: isSelected ? 5 : 1,
                  }}
                >
                  <RowTimestamp item={item} isSelected={isSelected} narrow={narrow} nowLabel={nowLabel} />
                </button>
              );
            })}
          </div>

          {/* ── Center selection band — desktop only. Narrow mode drops it:
               the focal scale and the brand-colored clock mark the loaded slice. ── */}
          {!narrow && (
            <div
              className="pointer-events-none absolute left-5 right-0 top-1/2 -translate-y-1/2 border-y border-brand-500/20 bg-brand-500/10"
              style={{ height: rowH }}
            />
          )}

          {/* ── Central rolling readout — anchored to the axis, desktop only
               (in the narrow gear each row's clock IS the readout). The rows
               already carry the full date, so it stays a rolling HH:MM,
               clamped so it can never push past the column's edge. ── */}
          {!narrow && (
            <div className="pointer-events-none absolute left-5 top-1/2 z-10 -translate-y-1/2">
              <div className="flex w-max max-w-[calc(100%-1.25rem)] flex-col items-start gap-1 overflow-hidden rounded-lg bg-background/80 px-2 py-1 backdrop-blur-sm">
                <span className="whitespace-nowrap text-xs font-medium text-foreground">
                  {focused ? (focused.isNow ? nowLabel : <RollingTime timestamp={focused.start} />) : null}
                </span>
                {focused && !focused.isNow && focused.focus && (
                  <span className="max-w-full truncate text-[0.55rem] text-muted-foreground">
                    {focused.focus}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Edge fade for depth (desktop only — narrow keeps no background
               band that could cover the static spine). ── */}
          {!narrow && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-background to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
            </>
          )}
        </>
      )}
      </div>
    </div>
  );
}
