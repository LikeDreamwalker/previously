"use client";

/**
 * StackList (Rev 8 §R8) — the timeline's right field: ONE virtualized DOM
 * list of rows whose granularity is the zoom level (L0 slice / L1 day stack /
 * L2 month stack, `src/lib/timeline3d/stacks.ts`).
 *
 * - Wheel scrolls time (newest at the bottom, scroll up into the past —
 *   same reading direction as the chat stream; pages prepend via
 *   `onNeedOlder` with virtuoso's firstItemIndex bookkeeping, mirroring
 *   unified-chat-stream.tsx).
 * - Ctrl/Cmd+wheel or two-finger pinch STEPS the level (discrete, accumulated
 *   over a threshold — the Rev 7 gesture discipline, minus the camera).
 * - Clicking a stack steps the WHOLE view one level finer, re-anchored on
 *   that group ("洗牌一起洗", no per-stack local expand). Clicking a slice
 *   card opens the reading panel via `onOpenSlice`.
 * - Every level/filter/page change re-anchors the list on the same entry
 *   (`indexForAnchor`) so the world never jumps.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  DEFAULT_LEVEL,
  cardGeometryFor,
  groupForLevel,
  indexForAnchor,
  rowPitchFor,
  type StackLevel,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import { pileSpecsFor } from "@/lib/timeline3d/pile-scene";
import { STRAND_PALETTE, oklchToHex } from "@/lib/timeline3d/layout";
import { SliceCard, StackCard } from "./cards";

const PileField = dynamic(() => import("./pile-field"), { ssr: false });

export interface StackListProps {
  /** Catalog window, already strand-filtered (oldest → newest). */
  entries: TimelineSliceEntry[];
  hasMore: boolean;
  onNeedOlder: () => void;
  /** L0 card click → dock the reading panel. */
  onOpenSlice: (sliceId: string) => void;
  /** ?at= deep link: land at L0 on this slice, flashed. */
  initialAtId?: string;
  /** Identity of the current filter — a change re-plays the row entrance. */
  genKey?: string;
  /** WebGL available — the pile under stack cards is the R3F pile field;
   *  without it the cards fall back to flat DOM shells. */
  pile3d?: boolean;
}

/** virtuoso firstItemIndex base — prepends shift it down from here. */
const FIRST_INDEX_BASE = 1_000_000;
/** Ctrl+wheel deltaY px per level step (Rev 7's value, same feel). */
const ZOOM_STEP_PX = 120;
const PINCH_STEP_PX = 90;
/** Idle this long and the zoom accumulator resets (a new gesture). */
const ZOOM_ACCUM_IDLE_MS = 350;

export function StackList({
  entries,
  hasMore,
  onNeedOlder,
  onOpenSlice,
  initialAtId,
  genKey = "",
  pile3d = false,
}: StackListProps) {
  const t = useTranslations("timeline3d");
  const reducedMotion = useReducedMotion() ?? false;
  const { resolvedTheme } = useTheme();
  const [level, setLevel] = useState<StackLevel>(initialAtId ? 0 : DEFAULT_LEVEL);
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_INDEX_BASE);
  const [flashId, setFlashId] = useState<string | null>(initialAtId ?? null);

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Card geometry (§R9.1): fixed-size cards in responsive tiers, measured
  // off the list FIELD (viewport minus the ambient strip), shared with the
  // pile field as the single source of truth.
  const [fieldW, setFieldW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setFieldW(el.clientWidth);
    const ro = new ResizeObserver(() => setFieldW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [entries.length]);
  const geo = useMemo(() => cardGeometryFor(fieldW || 1280), [fieldW]);
  /** Data index of the first visible row — the re-anchor's source. */
  const firstVisibleRef = useRef(0);
  /** Entry id to re-anchor on after the next rows change (level/filter). */
  const pendingAnchorRef = useRef<string | null>(null);

  const rows = useMemo(() => groupForLevel(entries, level), [entries, level]);

  // ── Older-page trigger: EDGE-entering the top zone, not startReached ──
  // virtuoso mounts at scrollTop=0 (and re-mounts there on every level-key
  // remount), so startReached fires at boot and double-prefetches — and the
  // obvious onScroll gate doesn't exist in virtuoso's API (the prop is
  // silently dropped). Instead we listen on the scroller element directly
  // and fire only when the scroll position ENTERS the top zone from below
  // it (mount/jump frames never produce that transition).
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const prevTopRef = useRef<number | null>(null);
  const setScrollerEl = useCallback((el: HTMLElement | Window | null) => {
    scrollerElRef.current = el instanceof HTMLElement ? el : null;
    prevTopRef.current = null; // a new scroller (level remount) starts fresh
  }, []);

  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const TOP_ZONE = 240;
    const onScroll = () => {
      const top = el.scrollTop;
      const prev = prevTopRef.current;
      prevTopRef.current = top;
      if (prev != null && prev > TOP_ZONE && top <= TOP_ZONE && hasMore) {
        onNeedOlder();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMore, onNeedOlder, level, rows.length]);

  /** Hovered stack row key — DOM pointer events feed the pile field. */
  const hoverKeyRef = useRef<string | null>(null);

  // ── Row-entrance generation: bumped (render-phase, idempotently) on every
  // level/filter change AND on first mount. Rows mounted within the window
  // rise in a stagger; rows mounted later by plain scrolling stay static —
  // the pile field's deal-in covers the same beat for stack levels.
  const genAtRef = useRef(-1);
  const genTrackRef = useRef<{ level: StackLevel; genKey: string } | null>(null);
  if (
    genTrackRef.current === null ||
    genTrackRef.current.level !== level ||
    genTrackRef.current.genKey !== genKey
  ) {
    genTrackRef.current = { level, genKey };
    genAtRef.current = performance.now();
  }

  // ── Prepend bookkeeping: keep the viewport put when older pages land ──
  const prevRowsRef = useRef<{ level: StackLevel; firstKey: string | null }>({
    level,
    firstKey: null,
  });
  useLayoutEffect(() => {
    const prev = prevRowsRef.current;
    const firstKey = rows[0]?.key ?? null;
    if (
      prev.firstKey &&
      prev.level === level &&
      firstKey &&
      firstKey !== prev.firstKey
    ) {
      const added = rows.findIndex((r) => r.key === prev.firstKey);
      if (added > 0) setFirstItemIndex((v) => v - added);
    }
    prevRowsRef.current = { level, firstKey };
  }, [rows, level]);

  // ── Level stepping (click / ctrl+wheel / pinch all funnel here) ──
  const stepLevel = useCallback(
    (next: StackLevel, anchorId?: string) => {
      setLevel((cur) => {
        if (next === cur) return cur;
        pendingAnchorRef.current =
          anchorId ?? rows[firstVisibleRef.current]?.top.id ?? null;
        return next;
      });
    },
    [rows],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      setLevel((cur) => {
        const next = Math.min(2, Math.max(0, cur + dir)) as StackLevel;
        if (next === cur) return cur;
        pendingAnchorRef.current =
          rows[firstVisibleRef.current]?.top.id ?? null;
        return next;
      });
    },
    [rows],
  );

  // Re-anchor once the new level's rows are in.
  useLayoutEffect(() => {
    const id = pendingAnchorRef.current;
    if (id == null) return;
    pendingAnchorRef.current = null;
    const idx = indexForAnchor(rows, id);
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: idx,
        align: "center",
        behavior: "auto",
      });
    }
  }, [rows]);

  // ── ?at= deep link: land on the slice once it's in the rows ──
  const atDoneRef = useRef(false);
  useLayoutEffect(() => {
    if (!initialAtId || atDoneRef.current || level !== 0) return;
    const idx = indexForAnchor(rows, initialAtId);
    if (idx < 0) return;
    atDoneRef.current = true;
    virtuosoRef.current?.scrollToIndex({
      index: idx,
      align: "center",
      behavior: "auto",
    });
  }, [rows, initialAtId, level]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 3600);
    return () => clearTimeout(timer);
  }, [flashId]);

  // ── Gestures: ctrl+wheel / pinch step the level, plain wheel scrolls ──
  const zoomAccumRef = useRef(0);
  const zoomIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = native scroll
      e.preventDefault();
      zoomAccumRef.current += e.deltaY;
      if (zoomIdleRef.current) clearTimeout(zoomIdleRef.current);
      zoomIdleRef.current = setTimeout(() => {
        zoomAccumRef.current = 0;
      }, ZOOM_ACCUM_IDLE_MS);
      if (Math.abs(zoomAccumRef.current) >= ZOOM_STEP_PX) {
        const dir = zoomAccumRef.current > 0 ? 1 : -1; // down = zoom out
        zoomAccumRef.current = 0;
        zoomBy(dir);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (zoomIdleRef.current) clearTimeout(zoomIdleRef.current);
    };
  }, [zoomBy]);

  // Two-finger pinch (touch pointers only) — spread = zoom in.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastDist: number | null = null;
    let accum = 0;
    const dist = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        lastDist = dist();
        accum = 0;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2) return;
      const d = dist();
      if (d == null || lastDist == null) return;
      accum += d - lastDist;
      lastDist = d;
      if (Math.abs(accum) >= PINCH_STEP_PX) {
        const dir = accum > 0 ? -1 : 1; // spread = zoom in
        accum = 0;
        zoomBy(dir);
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastDist = null;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [zoomBy]);

  const onRangeChanged = useCallback((range: ListRange) => {
    firstVisibleRef.current = range.startIndex;
  }, []);

  // ── Fill pass: a list shorter than its viewport can never be scrolled ──
  // into the top zone — keep loading older windows until it overflows or the
  // catalog runs out. SETTLED, not mount-time: virtuoso's first frames report
  // a scrollHeight from unmeasured rows (smaller than the real one), so an
  // eager check double-prefetches. Re-run after every rows change, behind a
  // settle timer — the truth only exists once the layout has.
  useEffect(() => {
    if (!hasMore) return;
    const timer = setTimeout(() => {
      const el = scrollerElRef.current;
      if (el && el.scrollHeight <= el.clientHeight + 1) onNeedOlder();
    }, 900);
    return () => clearTimeout(timer);
  }, [rows, hasMore, onNeedOlder]);

  const renderRow = useCallback(
    (index: number, row: StackRow) => {
      const flash = flashId != null && row.entries.some((e) => e.id === flashId);
      // Entrance stagger: only rows mounted inside the generation window.
      const sinceGen = performance.now() - genAtRef.current;
      const entering = !reducedMotion && sinceGen >= 0 && sinceGen < 650;
      const enterDelay = entering
        ? Math.min(Math.max(index - firstVisibleRef.current, 0), 10) * 0.035
        : 0;
      // Fixed-pitch rows (§R9.1): the card column is centered, the row height
      // is exactly `rowPitchFor` — the pile field reads the same constants.
      return (
        <div
          className="flex justify-center"
          style={{ height: rowPitchFor(row.level, geo) }}
          onPointerEnter={
            row.level > 0 ? () => (hoverKeyRef.current = row.key) : undefined
          }
          onPointerLeave={
            row.level > 0 ? () => (hoverKeyRef.current = null) : undefined
          }
        >
          <motion.div
            className="flex justify-center"
            initial={entering ? { opacity: 0, y: 16 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: enterDelay, ease: "easeOut" }}
          >
            {row.level === 0 ? (
              <SliceCard
                entry={row.top}
                geo={geo}
                flash={flash}
                onOpen={onOpenSlice}
              />
            ) : (
              <StackCard
                row={row}
                geo={geo}
                flash={flash}
                shells={!pile3d}
                onZoomIn={(r) =>
                  stepLevel((r.level - 1) as StackLevel, r.top.id)
                }
              />
            )}
          </motion.div>
        </div>
      );
    },
    [flashId, onOpenSlice, stepLevel, geo, pile3d, reducedMotion],
  );

  const brandHex = oklchToHex(STRAND_PALETTE[0]);
  const pitch = rowPitchFor(level, geo);
  const pileSpecs = useMemo(
    () => (level > 0 ? pileSpecsFor(rows) : []),
    [rows, level],
  );

  if (entries.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("fallback.empty")}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      style={{ touchAction: "pan-y" }}
    >
      {/* The 3D pile base UNDER the list (§R9.2) — rows stay transparent,
          cards are opaque and occlude each pile's top sheet. */}
      {pile3d && pileSpecs.length > 0 && (
        <PileField
          specs={pileSpecs}
          geo={geo}
          pitch={pitch}
          scrollerElRef={scrollerElRef}
          hoverKeyRef={hoverKeyRef}
          dark={resolvedTheme !== "light"}
          reducedMotion={reducedMotion}
        />
      )}

      {/* Keyed by level: the list crossfades on every step; the re-anchor
          effect then lands the same group in the middle of the frame. */}
      <motion.div
        key={level}
        className="relative z-10 h-full"
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
      >
        <Virtuoso
          ref={virtuosoRef}
          scrollerRef={setScrollerEl}
          data={rows}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={Math.max(0, rows.length - 1)}
          rangeChanged={onRangeChanged}
          itemContent={renderRow}
          increaseViewportBy={{ top: 600, bottom: 300 }}
          className="h-full"
        />
      </motion.div>

      {/* NOW tail marker — the list's bottom is the present. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
      <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-[1px]"
          style={{ backgroundColor: brandHex }}
        />
        {t("now.label")} · {t("now.sub")}
      </div>
    </div>
  );
}
