"use client";

/**
 * CardField (Rev 12) — the timeline's right field: the cards ARE the scene.
 * One R3F canvas renders the current zoom level's rows as big film-frame
 * cards on the z=0 plane; each stack (L1/L2) is a real 3D deck — the top
 * card is the full original slice card (never a summary), and 1–6 backing
 * sheets of the SAME size/radius/color cascade behind it (`backingSheets`
 * tiers in stacks.ts) so a pile reads as thick without rendering its count.
 *
 * - Virtualized: only rows near the viewport mount (a handful of cards; the
 *   catalog may hold thousands). Scroll state lives in refs — React only
 *   re-renders when the visible range or the level changes.
 * - Scroll: wheel / one-finger drag move through time (bottom = NOW); the
 *   shared `progressRef` reports 0..1 to the ambient threadline. Nearing the
 *   top edge prefetches the older catalog window (`onNeedOlder`), and a
 *   prepend shifts the scroll offset so the world never jumps.
 * - Zoom: ctrl/cmd+wheel or two-finger pinch steps L0 slice ↔ L1 day ↔
 *   L2 month; clicking a stack steps one level finer, anchored on it. Every
 *   level change captures a transition snapshot: the new rows fly from their
 *   OLD slot positions (or from the stack they were swallowed by) to their
 *   NEW slots, while cards that disappear into a coarser stack fly into that
 *   pile as leaving cards. Filter changes and initial mount keep the existing
 *   anchor-pile deal fallback.
 * - Card faces are drei Html (real DOM in 3D — perspective comes free from
 *   the camera); backing sheets are real R3F meshes with paper tone + rim so
 *   scroll-driven camera drift produces visible parallax between layers.
 *
 * Rev 12 data-flow change: slice turn content used to be hoisted into this
 * component as `Map<string, ContentSlot>` and batched via `onRangeChange`.
 * Every fetch resolve re-rendered the whole FieldScene → RowGroup tree and
 * made the field flicker while scrolling. Content loading is now per-card
 * inside `SliceCardFace` (via `useSliceTurns`); the outer components only
 * pass the row/entry array and never re-render for data resolves.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useLocale, useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  DEFAULT_LEVEL,
  frameGeometryFor,
  framePitchFor,
  groupForLevel,
  indexForAnchor,
  type FrameGeometry,
  type StackLevel,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import { FrameCardTexts, frameCardLabel } from "./frame-card";
import { RowGroup } from "./row-group";
import { LeavingCard } from "./leaving-card";
import type { DealOrigin, FieldRig, LeavingItem } from "./field-rig";

export interface CardFieldProps {
  /** Catalog window, already strand-filtered (oldest → newest). */
  entries: TimelineSliceEntry[];
  hasMore: boolean;
  onNeedOlder: () => void;
  /** L0 card click → dock the reading panel. */
  onOpenSlice: (sliceId: string) => void;
  /** ?at= deep link: land at L0 on this slice, flashed. */
  initialAtId?: string;
  /** Identity of the current filter — a change re-plays the deal. */
  genKey?: string;
  reducedMotion: boolean;
  /** Written every frame: scroll progress 0..1 (0 = oldest, 1 = now). */
  progressRef: React.MutableRefObject<number>;
}

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Ctrl+wheel deltaY px per level step; pinch threshold; idle reset. */
const ZOOM_STEP_PX = 120;
const PINCH_STEP_PX = 90;
const ZOOM_ACCUM_IDLE_MS = 350;
/** Entering this zone from below (px from the content top) prefetches older. */
const TOP_ZONE_PX = 320;
/** Deal-in: seconds; stagger per row of distance from the anchor. */
const DEAL_DURATION = 0.55;
const DEAL_STAGGER = 0.05;
/** Mounts within this window after a level/filter change play the deal. */
const GEN_WINDOW_MS = 650;
/** Stagger for leaving cards stacking into a pile, seconds per depth step. */
const LEAVING_STAGGER_S = 0.03;

/** Camera that the scene and the world-scale math both agree on. */
const CAM_Z = 9;
const CAM_FOV = 30;

/** World units per CSS px for the fixed camera and a given field height. */
function worldPerPxForField(fieldH: number): number {
  return (2 * CAM_Z * Math.tan((CAM_FOV * Math.PI) / 360)) / fieldH;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Find the old row that visually contained `sliceId` (top or buried). */
function findOldSlot(
  sliceId: string,
  rows: StackRow[],
): { index: number; isTop: boolean } | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.top.id === sliceId) return { index: i, isTop: true };
    if (row.entries.some((e) => e.id === sliceId))
      return { index: i, isTop: false };
  }
  return null;
}

/** Scroll offset that centers `anchorIdx` in the field, clamped to content. */
function centeredScrollForAnchor(
  anchorIdx: number,
  rowCount: number,
  pitch: number,
  cardH: number,
  fieldH: number,
): number {
  const max = Math.max(0, rowCount * pitch - fieldH);
  return THREE.MathUtils.clamp(
    anchorIdx * pitch + cardH / 2 - fieldH / 2,
    0,
    max,
  );
}

/** Row keys visible (including virtual-scroll margin) at a given scroll. */
function visibleKeysFor(
  rows: StackRow[],
  pitch: number,
  cardH: number,
  fieldH: number,
  scrollPx: number,
): Set<string> {
  const margin = cardH * 1.2;
  const first = Math.max(0, Math.floor((scrollPx - margin) / pitch));
  const last = Math.min(
    rows.length - 1,
    Math.ceil((scrollPx + fieldH + margin) / pitch),
  );
  const set = new Set<string>();
  for (let i = first; i <= last; i++) {
    if (rows[i]) set.add(rows[i].key);
  }
  return set;
}

/** Build the list of cards that get swallowed when zooming out.
 *  Only cards in the old visible window participate. */
function buildLeaving(
  fromRows: StackRow[],
  fromScroll: number,
  fromPitch: number,
  fromCardH: number,
  toRows: StackRow[],
  fieldH: number,
): LeavingItem[] {
  const margin = fromCardH * 1.2;
  const first = Math.max(0, Math.floor((fromScroll - margin) / fromPitch));
  const last = Math.min(
    fromRows.length - 1,
    Math.ceil((fromScroll + fieldH + margin) / fromPitch),
  );
  const newTops = new Set(toRows.map((r) => r.top.id));
  const toRowById = new Map<string, { key: string; depth: number }>();
  for (const row of toRows) {
    for (let i = 0; i < row.entries.length; i++) {
      toRowById.set(row.entries[i].id, { key: row.key, depth: i });
    }
  }
  const items: LeavingItem[] = [];
  for (let i = first; i <= last; i++) {
    const row = fromRows[i];
    if (!row) continue;
    const fromYpx = i * fromPitch + fromCardH / 2 - fromScroll;
    for (const entry of row.entries) {
      if (newTops.has(entry.id)) continue;
      const target = toRowById.get(entry.id);
      if (!target) continue;
      items.push({
        id: entry.id,
        slice: entry,
        fromYpx,
        toRowKey: target.key,
        depth: target.depth,
      });
    }
  }
  return items;
}

// ─── The scene: scroll physics + visible-range virtualization ───────────────

interface FieldSceneProps {
  rows: StackRow[];
  geo: FrameGeometry;
  level: StackLevel;
  rig: React.MutableRefObject<FieldRig>;
  hasMore: boolean;
  onNeedOlder: () => void;
  progressRef: React.MutableRefObject<number>;
  reducedMotion: boolean;
  flashId: string | null;
  onActivate: (row: StackRow) => void;
  arias: Map<string, string>;
  texts: FrameCardTexts;
  leaving: LeavingItem[];
  onLeavingDone: (id: string) => void;
}

function FieldScene({
  rows,
  geo,
  level,
  rig,
  hasMore,
  onNeedOlder,
  progressRef,
  reducedMotion,
  flashId,
  onActivate,
  arias,
  texts,
  leaving,
  onLeavingDone,
}: FieldSceneProps) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);
  const pitch = framePitchFor(level, geo);
  const prevTopRef = useRef<number | null>(null);
  // The visible range is STATE (drives which RowGroups mount), mirrored in a
  // ref so the frame loop can compare without a stale closure. Reading a ref
  // during render would leave stale rows mounted after a level change when no
  // state update happens to re-render.
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const rangeRef = useRef<[number, number]>([0, -1]);
  const prevRowsRef = useRef<StackRow[]>(rows);
  const prevRangeFirstKeyRef = useRef<string | null>(null);

  // Render-time range realignment on rows change: keep the viewport anchored to
  // the same row keys so React does not remount the visible RowGroups.
  if (prevRowsRef.current !== rows) {
    const [oldFirst, oldLast] = rangeRef.current;
    const oldKey = prevRangeFirstKeyRef.current;
    if (oldKey != null && oldFirst >= 0 && oldLast >= oldFirst) {
      const newFirst = rows.findIndex((r) => r.key === oldKey);
      if (newFirst >= 0) {
        const newLast = Math.min(
          rows.length - 1,
          newFirst + (oldLast - oldFirst),
        );
        const newRange: [number, number] = [newFirst, newLast];
        rangeRef.current = newRange;
        setRange(newRange);
      }
    }
    prevRowsRef.current = rows;
  }
  prevRangeFirstKeyRef.current = rows[rangeRef.current[0]]?.key ?? null;

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const rigNow = rig.current;
    const max = Math.max(0, rows.length * pitch - size.height);
    rigNow.target = THREE.MathUtils.clamp(rigNow.target, 0, max);

    if (reducedMotion) {
      rigNow.current = rigNow.target;
    } else {
      rigNow.current +=
        (rigNow.target - rigNow.current) * Math.min(1, 1 - Math.exp(-dt * 9));
      if (Math.abs(rigNow.target - rigNow.current) < 0.05) {
        rigNow.current = rigNow.target;
      }
    }

    // Top-zone EDGE trigger: only a real scroll up into the zone prefetches.
    const prevTop = prevTopRef.current;
    prevTopRef.current = rigNow.target;
    if (
      prevTop != null &&
      prevTop > TOP_ZONE_PX &&
      rigNow.target <= TOP_ZONE_PX &&
      hasMore
    ) {
      onNeedOlder();
    }

    progressRef.current = max > 0 ? rigNow.current / max : 1;

    // Scroll-driven camera drift: translate the camera slightly, then TURN it
    // back onto the card column (lookAt x=0) so the z=0 faces stay horizontally
    // centered while sheets at different depths shift by different amounts
    // (real parallax). A pure translation (lookAt(cx,cy,0)) would keep the axis
    // parallel to z and drag the whole card plane sideways — don't do that.
    if (!reducedMotion) {
      const p = progressRef.current; // 0..1 (0 = oldest/top, 1 = newest/bottom)
      const cx = (p - 0.5) * 2 * 0.42; // ±0.42 world units
      const cy = (p - 0.5) * 2 * 0.14; // ±0.14 world units
      camera.position.set(cx, cy, CAM_Z);
      camera.lookAt(0, cy, 0);
    } else {
      camera.position.set(0, 0, CAM_Z);
      camera.lookAt(0, 0, 0);
    }

    // Visible-range virtualization (React state changes only when it does).
    const margin = geo.cardH * 1.2;
    const first = Math.max(
      0,
      Math.floor((rigNow.current - margin) / pitch),
    );
    const last = Math.min(
      rows.length - 1,
      Math.ceil((rigNow.current + size.height + margin) / pitch),
    );
    if (first !== rangeRef.current[0] || last !== rangeRef.current[1]) {
      rangeRef.current = [first, last];
      setRange([first, last]);
    }
  });

  const rowIndexMap = useMemo(
    () => new Map(rows.map((r, i) => [r.key, i])),
    [rows],
  );

  const [first, last] = range;
  const visible = rows.slice(first, last + 1);

  return (
    <>
      {visible.map((row, vi) => {
        const index = first + vi;
        return (
          <RowGroup
            key={row.key}
            row={row}
            index={index}
            geo={geo}
            pitch={pitch}
            rig={rig}
            reducedMotion={reducedMotion}
            flash={flashId != null && row.entries.some((e) => e.id === flashId)}
            onActivate={onActivate}
            ariaLabel={arias.get(row.key) ?? ""}
            texts={texts}
          />
        );
      })}
      {leaving.map((item) => (
        <LeavingCard
          key={item.id}
          item={item}
          rowIndexMap={rowIndexMap}
          level={level}
          geo={geo}
          rig={rig}
          reducedMotion={reducedMotion}
          texts={texts}
          onDone={onLeavingDone}
        />
      ))}
    </>
  );
}

// ─── The field: DOM wrapper owns gestures, level, anchor, deal state ──

export function CardField({
  entries,
  hasMore,
  onNeedOlder,
  onOpenSlice,
  initialAtId,
  genKey = "",
  reducedMotion,
  progressRef,
}: CardFieldProps) {
  const t = useTranslations("timeline3d");
  const locale = useLocale();
  const texts = useMemo<FrameCardTexts>(
    () => ({
      turns: (count: number) => t("card.turns", { count }),
      user: t("turns.user"),
      agent: t("turns.agent"),
      duration: (min: number) => t("card.duration", { min }),
      no: (date: string, time: string) => t("card.no", { date, time }),
      tone: t("card.tone"),
      decided: t("card.decided"),
      open: t("card.open"),
      strands: t("card.strands"),
      listSeparator: t("card.listSeparator"),
      continuedFrom: (date: string) => t("card.continuedFrom", { date }),
      fr: (date: string) => t("card.fr", { date }),
    }),
    [t],
  );
  const [level, setLevel] = useState<StackLevel>(
    initialAtId ? 0 : DEFAULT_LEVEL,
  );
  const [flashId, setFlashId] = useState<string | null>(initialAtId ?? null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fieldSize, setFieldSize] = useState({ w: 0, h: 0 });
  const [leaving, setLeaving] = useState<LeavingItem[]>([]);

  const rig = useRef<FieldRig>({
    target: 0,
    current: 0,
    anchorIndex: 0,
    genAt: performance.now(),
    hoverKey: null,
    dealOrigins: null,
    dealEligible: null,
  });
  const pendingAnchorRef = useRef<string | null>(initialAtId ?? null);
  const initDoneRef = useRef(false);
  const prevFirstKeyRef = useRef<string | null>(null);

  const rows = useMemo(() => groupForLevel(entries, level), [entries, level]);
  const geo = useMemo(
    () => frameGeometryFor(fieldSize.w || 1280, fieldSize.h || 800),
    [fieldSize],
  );

  // Render-time prepend compensation: shift the scroll rig synchronously so the
  // next frame's RowGroup positions use the corrected offset, avoiding a
  // one-frame jump before the useEffect could run.
  if (rows.length > 0) {
    const firstKey = rows[0]?.key ?? null;
    const prevFirst = prevFirstKeyRef.current;
    if (prevFirst && prevFirst !== firstKey && !pendingAnchorRef.current) {
      const added = rows.findIndex((r) => r.key === prevFirst);
      if (added > 0) {
        const pitch = framePitchFor(level, geo);
        rig.current.target += added * pitch;
        rig.current.current += added * pitch;
        rig.current.genAt = 0;
        rig.current.dealEligible = null;
      }
    }
    prevFirstKeyRef.current = firstKey;
  }

  const arias = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.key, frameCardLabel(row, locale).aria);
    return map;
  }, [rows, locale]);

  // ── Field size (ResizeObserver) ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setFieldSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() =>
      setFieldSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Generation bookkeeping: bump the deal clock on level/filter change ──
  const genTrackRef = useRef<{ level: StackLevel; genKey: string } | null>(null);
  if (
    genTrackRef.current === null ||
    genTrackRef.current.level !== level ||
    genTrackRef.current.genKey !== genKey
  ) {
    genTrackRef.current = { level, genKey };
    rig.current.genAt = performance.now();
    rig.current.dealEligible = visibleKeysFor(
      rows,
      framePitchFor(level, geo),
      geo.cardH,
      fieldSize.h || 800,
      rig.current.current,
    );
  }

  // Filter changes are not level transitions: clear stale deal origins
  // so rows fall back to the anchor-pile deal.
  const lastGenKeyRef = useRef<string>(genKey);
  useEffect(() => {
    if (lastGenKeyRef.current !== genKey) {
      lastGenKeyRef.current = genKey;
      rig.current.dealOrigins = null;
      setLeaving([]);
    }
  }, [genKey]);

  // ── Start a real level transition (snapshot + leaving cards) ──
  const startTransition = useCallback(
    (
      fromLevel: StackLevel,
      toLevel: StackLevel,
      anchorId: string | null,
    ) => {
      pendingAnchorRef.current = anchorId;
      if (reducedMotion) {
        rig.current.dealOrigins = null;
        rig.current.dealEligible = null;
        setLeaving([]);
        return;
      }
      const fromRows = groupForLevel(entries, fromLevel);
      const toRows = groupForLevel(entries, toLevel);
      const fromPitch = framePitchFor(fromLevel, geo);
      const toPitch = framePitchFor(toLevel, geo);
      const fromCardH = geo.cardH;
      const toCardH = geo.cardH;
      const scroll = rig.current.current;
      const fieldH = fieldSize.h || 800;

      const wpp = worldPerPxForField(fieldH);
      const dealOrigins = new Map<string, DealOrigin>();

      const anchorIdx = anchorId ? indexForAnchor(toRows, anchorId) : -1;
      if (anchorIdx >= 0) rig.current.anchorIndex = anchorIdx;
      const newCurrent =
        anchorIdx >= 0
          ? centeredScrollForAnchor(
              anchorIdx,
              toRows.length,
              toPitch,
              toCardH,
              fieldH,
            )
          : scroll;
      // Pre-apply the post-transition scroll so the first rendered frame
      // already uses the same current that RowGroup will animate toward.
      rig.current.current = newCurrent;
      rig.current.target = newCurrent;

      for (let newIdx = 0; newIdx < toRows.length; newIdx++) {
        const row = toRows[newIdx];
        const old = findOldSlot(row.top.id, fromRows);
        if (old == null) continue;
        const newCenterPy = newIdx * toPitch + toCardH / 2 - newCurrent;
        const oldCenterPy = old.index * fromPitch + fromCardH / 2 - scroll;
        dealOrigins.set(row.key, {
          dy: (newCenterPy - oldCenterPy) * wpp,
          dz: -0.45,
        });
      }

      rig.current.dealOrigins = dealOrigins;
      rig.current.genAt = performance.now();
      rig.current.dealEligible = visibleKeysFor(
        toRows,
        toPitch,
        toCardH,
        fieldH,
        newCurrent,
      );

      setLeaving(
        fromLevel < toLevel
          ? buildLeaving(fromRows, scroll, fromPitch, fromCardH, toRows, fieldH)
          : [],
      );
    },
    [entries, geo, fieldSize.h, reducedMotion],
  );

  // ── Anchor / scroll position after rows change (level, filter, paging) ──
  useEffect(() => {
    if (rows.length === 0) return;
    const pitch = framePitchFor(level, geo);
    const max = Math.max(0, rows.length * pitch - fieldSize.h);

    // Prepend compensation now runs synchronously during render (above).

    const anchorId = pendingAnchorRef.current;
    if (anchorId != null) {
      pendingAnchorRef.current = null;
      const idx = indexForAnchor(rows, anchorId);
      if (idx >= 0) {
        rig.current.anchorIndex = idx;
        const pos = centeredScrollForAnchor(
          idx,
          rows.length,
          pitch,
          geo.cardH,
          fieldSize.h,
        );
        rig.current.target = pos;
        rig.current.current = pos;
        rig.current.genAt = performance.now();
        rig.current.dealEligible = visibleKeysFor(
          rows,
          pitch,
          geo.cardH,
          fieldSize.h,
          pos,
        );
      }
      return;
    }
    if (!initDoneRef.current) {
      // Bottom-anchored first land: the list's bottom is NOW.
      initDoneRef.current = true;
      rig.current.anchorIndex = rows.length - 1;
      rig.current.target = max;
      rig.current.current = max;
      rig.current.genAt = performance.now();
      rig.current.dealEligible = visibleKeysFor(
        rows,
        pitch,
        geo.cardH,
        fieldSize.h,
        max,
      );
    }
  }, [rows, geo, level, fieldSize.h]);

  // ── Fill pass: content shorter than the field can never reach the top ──
  useEffect(() => {
    if (!hasMore || rows.length === 0) return;
    const timer = setTimeout(() => {
      if (rows.length * framePitchFor(level, geo) <= fieldSize.h + 1) onNeedOlder();
    }, 900);
    return () => clearTimeout(timer);
  }, [rows, hasMore, onNeedOlder, geo, level, fieldSize.h]);

  // ── ?at= flash decay ──
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 3600);
    return () => clearTimeout(timer);
  }, [flashId]);

  // ── Level stepping ──
  const stepLevel = useCallback(
    (next: StackLevel, anchorId?: string) => {
      if (next === level) return;
      startTransition(level, next, anchorId ?? null);
      setLevel(next);
    },
    [level, startTransition],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      const next = Math.min(2, Math.max(0, level + dir)) as StackLevel;
      if (next === level) return;
      const curPitch = framePitchFor(level, geo);
      const centerRow = Math.max(
        0,
        Math.round(
          (rig.current.current + fieldSize.h / 2 - geo.cardH / 2) / curPitch,
        ),
      );
      const curRows = groupForLevel(entries, level);
      const anchorId = curRows[centerRow]?.top.id ?? null;
      startTransition(level, next, anchorId);
      setLevel(next);
    },
    [level, entries, geo, fieldSize.h, startTransition],
  );

  const onActivate = useCallback(
    (row: StackRow) => {
      if (row.level === 0) onOpenSlice(row.top.id);
      else stepLevel((row.level - 1) as StackLevel, row.top.id);
    },
    [onOpenSlice, stepLevel],
  );

  const onLeavingDone = useCallback((id: string) => {
    setLeaving((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // ── Gestures: wheel (plain = scroll, ctrl/cmd = zoom), touch drag, pinch ──
  const zoomAccumRef = useRef(0);
  const zoomIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAccumRef.current += e.deltaY;
        if (zoomIdleRef.current) clearTimeout(zoomIdleRef.current);
        zoomIdleRef.current = setTimeout(() => {
          zoomAccumRef.current = 0;
        }, ZOOM_ACCUM_IDLE_MS);
        if (Math.abs(zoomAccumRef.current) >= ZOOM_STEP_PX) {
          const dir = zoomAccumRef.current > 0 ? 1 : -1;
          zoomAccumRef.current = 0;
          zoomBy(dir);
        }
      } else {
        rig.current.target += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (zoomIdleRef.current) clearTimeout(zoomIdleRef.current);
    };
  }, [zoomBy]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastDist: number | null = null;
    let pinchAccum = 0;
    const dist = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        lastDist = dist();
        pinchAccum = 0;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId)!;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // One-finger vertical drag scrolls time.
        rig.current.target -= e.clientY - prev.y;
        return;
      }
      if (pointers.size !== 2) return;
      const d = dist();
      if (d == null || lastDist == null) return;
      pinchAccum += d - lastDist;
      lastDist = d;
      if (Math.abs(pinchAccum) >= PINCH_STEP_PX) {
        const dir = pinchAccum > 0 ? -1 : 1; // spread = zoom in
        pinchAccum = 0;
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
      data-card-field
      className="relative h-full w-full"
      style={{ touchAction: "none" }}
    >
      <Canvas
        dpr={[1, 1.75]}
        // Dead-on camera: cards on the z=0 plane always face the viewer
        // square-on (no keystone tilt). A pile's depth comes from its own
        // sheet offsets/tilts/shadows, not from the camera angle.
        camera={{ position: [0, 0, CAM_Z], fov: CAM_FOV }}
        gl={{ antialias: true, alpha: true }}
      >
        <FieldScene
          rows={rows}
          geo={geo}
          level={level}
          rig={rig}
          hasMore={hasMore}
          onNeedOlder={onNeedOlder}
          progressRef={progressRef}
          reducedMotion={reducedMotion}
          flashId={flashId}
          onActivate={onActivate}
          arias={arias}
          texts={texts}
          leaving={leaving}
          onLeavingDone={onLeavingDone}
        />
      </Canvas>
    </div>
  );
}
