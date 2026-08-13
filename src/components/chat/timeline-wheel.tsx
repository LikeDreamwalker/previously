"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

/** The central readout — a rolling YYYY/MM/DD · HH:MM. */
function RollingDate({ timestamp }: { timestamp: string }) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const mi = d.getMinutes();

  const sep = <span className="mx-0.5 text-muted-foreground/60">/</span>;
  return (
    <span className="inline-flex items-baseline font-mono leading-none">
      <RollingField value={y} digits={4} />
      {sep}
      <RollingField value={mo} digits={2} />
      {sep}
      <RollingField value={day} digits={2} />
      <span className="mx-0.5 text-muted-foreground/60">·</span>
      <RollingField value={h} digits={2} />
      <span className="mx-0.5 text-muted-foreground/60">:</span>
      <RollingField value={mi} digits={2} />
    </span>
  );
}

// ─── The wheel ──────────────────────────────────────────────────────────

export function TimelineWheel({ selectedId, pendingId, onSelect }: TimelineWheelProps) {
  const t = useTranslations("timeline");
  const [items, setItems] = useState<WheelItem[] | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  // Mouse drag-to-scroll state. `moved` distinguishes a drag from a click so a
  // drag that ends over a row doesn't accidentally load it.
  const dragRef = useRef({ active: false, moved: false, startY: 0, startScroll: 0 });

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
    const target = Math.max(0, (items.length - 1) * ROW_H);
    el.scrollTop = target;
    setScrollTop(el.scrollTop);
  }, [items, height]);

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
  const pad = Math.max(0, height / 2 - ROW_H / 2);
  const totalPx = items ? items.length * ROW_H + pad * 2 : 0;

  // Virtualized + focal-transform view of the visible rows.
  const visibleRows = useMemo(() => {
    if (!items || items.length === 0) return [];
    const start = Math.max(0, Math.floor((scrollTop - pad) / ROW_H) - RENDER_MARGIN);
    const end = Math.min(items.length, Math.ceil((scrollTop + height - pad) / ROW_H) + RENDER_MARGIN);
    const rows: Array<{ index: number; item: WheelItem; scale: number; opacity: number }> = [];
    for (let i = start; i < end; i++) {
      const item = items[i];
      const rowCenter = pad + i * ROW_H + ROW_H / 2;
      const dist = Math.abs(rowCenter - centerY);
      const tt = Math.min(1, dist / FADE_PX);
      rows.push({
        index: i,
        item,
        scale: 1 - tt * 0.32,
        opacity: 1 - tt * 0.7,
      });
    }
    return rows;
  }, [items, scrollTop, height, centerY, pad]);

  // The row nearest the selection band — drives the readout only. Content is
  // loaded on EXPLICIT click, not on scroll-settle, so browsing costs zero
  // requests (slice reads are GitHub API calls in production).
  const focusedIndex = useMemo(() => {
    if (!items || items.length === 0) return 0;
    const idx = Math.round((centerY - pad - ROW_H / 2) / ROW_H);
    return Math.max(0, Math.min(items.length - 1, idx));
  }, [items, centerY, pad]);
  const focused = items ? items[focusedIndex] : null;

  const centerOn = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // Rows sit at `pad + i*ROW_H + ROW_H/2` — the pad must be included so the
    // clicked row lands exactly on the selection band.
    const target = Math.max(0, pad + index * ROW_H + ROW_H / 2 - height / 2);
    el.scrollTo({ top: target, behavior: "smooth" });
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onClickCapture={handleClickCapture}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Timeline wheel"
      className={`relative h-full select-none overflow-y-auto overflow-x-hidden scrollbar-none ${
        dragging ? "cursor-grabbing" : "cursor-grab"
      }`}
    >
      {!items ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ── Virtualized rows ── */}
          <div className="relative" style={{ height: totalPx }}>
            {visibleRows.map(({ index, item, scale, opacity }) => {
              const isNow = item.isNow;
              // Blue = the LOADED slice (whose content is shown on the right),
              // OR the slice the user just clicked while its transition is
              // still rolling (pendingId) — so the glow lights instantly.
              // It does NOT follow scroll previews — only an explicit click
              // moves it.
              const isSelected = isNow
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
                  className="group absolute left-1/2 flex w-full cursor-pointer flex-col items-center gap-0.5 px-2 py-1"
                  style={{
                    top: pad + index * ROW_H + ROW_H / 2,
                    transform: `translate(-50%, -50%) scale(${scale})`,
                    opacity,
                    zIndex: isSelected ? 5 : 1,
                  }}
                >
                  {/* Soft brand glow under the label — the same "stage light" the
                      empty briefing uses. Sized to the label (not the full row)
                      so it never widens the column; lights instantly on click via
                      pendingId, and shows a fainter version on hover. */}
                  <span className="relative flex flex-col items-center gap-0.5">
                    <div
                      aria-hidden
                      className={`pointer-events-none absolute -inset-x-2 -inset-y-1.5 -z-10 rounded-full blur-md transition-opacity duration-200 ${
                        isSelected
                          ? "bg-brand-500/15 opacity-100"
                          : "bg-brand-500/8 opacity-0 group-hover:opacity-100"
                      }`}
                    />
                    <span
                      className={`font-mono text-[0.7rem] leading-tight tabular-nums transition-colors ${
                        isSelected
                          ? "text-brand-600 dark:text-brand-400"
                          : "text-muted-foreground/60 group-hover:text-foreground/80"
                      }`}
                    >
                      {formatDate(item.start)}
                    </span>
                    <span
                      className={`font-mono text-[0.8rem] leading-tight tabular-nums transition-colors ${
                        isSelected
                          ? "text-brand-600 dark:text-brand-400"
                          : "text-foreground/70 group-hover:text-foreground"
                      }`}
                    >
                      {isNow ? t("panel.now") : formatTime(item.start)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* ── Center selection band ── */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 border-y border-brand-500/20 bg-brand-500/10" style={{ height: ROW_H }} />

          {/* ── Central rolling readout ── */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 px-1">
            {/* w-max max-w-full: the readout sizes to its content but is clamped
                to the column so it can never push a horizontal scrollbar. */}
            <div className="mx-auto flex w-max max-w-full flex-col items-center gap-1 overflow-hidden rounded-lg bg-background/80 px-1.5 py-1 backdrop-blur-sm">
              <span className="whitespace-nowrap text-xs font-medium text-foreground">
                {focused?.isNow ? t("panel.now") : focused ? <RollingDate timestamp={focused.start} /> : null}
              </span>
              {focused && !focused.isNow && focused.focus && (
                <span className="max-w-full truncate text-[0.55rem] text-muted-foreground">
                  {focused.focus}
                </span>
              )}
            </div>
          </div>

          {/* ── Edge fade for depth ── */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-background to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
        </>
      )}
    </div>
  );
}
