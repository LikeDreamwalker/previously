"use client";

/**
 * The R3F scene itself — the heavy three.js bundle. Never imported directly:
 * `timeline-scene.tsx` loads it via next/dynamic with ssr:false so it stays
 * out of the first-load bundle and tree-shakes cleanly on the cloud target.
 *
 * Rev 7 (doc/design/v0.10.0-memory-viz.md §R7): the spine timeline with three
 * CALENDAR-GRAIN zoom levels — week (远眺, small cards) / day (俯瞰, medium
 * cards) / hour (凝视, full stage cards) — replacing the L0–L4 abstraction
 * tiers. Per level the catalog partitions into regions (weeks / days /
 * hours), each laying its slices out as a strict chronological serpentine
 * grid hung right of the spine (regions.ts, pure). Regions stack top-down,
 * oldest first; the spine runs straight into the glowing NOW point.
 * - Level discipline: the zoom gesture (Ctrl+wheel / pinch) STEPS between the
 *   three levels — the camera eases to the level's fixed distance while
 *   content switches to the target level in the same frame. Vertical scroll =
 *   camera Y (time travel, continuous — the grids live in world coordinates,
 *   no snapping). Rotation (Alt+drag / right-drag / two-finger rotate) orbits
 *   the spine and damps back. Zooming past hour while focused traverses into
 *   the chat.
 * - Click = drill down the question chain (§R7.3): a week/day card flies the
 *   camera one level deeper onto that slice's sub-region; an hour card opens
 *   the FocusCard.
 * - Strand rendering (§R7.2 serpentine traversal) lives in `strand-layer.tsx`:
 *   lane fibers left of the spine, through/bypass weaving per region, leg
 *   bundling, NOW convergence, flow dots — geometry pure in
 *   `lib/timeline3d/strand-scene.ts`.
 * - Glow: bloom with a high threshold and low intensity. Atmosphere
 *   (grid/vignette) is CSS outside the canvas (`atmosphere.tsx`) and follows
 *   the app theme; text is always DOM (drei Html, semantic Tailwind classes).
 *
 * The level semantics are pure (`regionZoomState` in regions.ts). This file
 * only wires.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line as DreiLine, Sparkles } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import { useRouter } from "@/i18n/navigation";
import {
  coreXAt,
  oklchToHex,
  strandColor,
  STRAND_PALETTE,
  STRANDLESS_GREY,
  NOW_GAP,
} from "@/lib/timeline3d/layout";
import {
  computeRegionScene,
  findSlicePosition,
  nearestSliceAtY,
  regionBottom,
  regionZoomState,
  perRowForWidth,
  levelConfigFor,
  FOV_DEG,
  ZOOM_REGIONS,
  MAX_ZOOM_LEVEL,
  type RegionLayout,
  type RegionScene,
  type RegionZoomState,
  type ZoomLevel,
} from "@/lib/timeline3d/regions";
import {
  focusReducer,
  INITIAL_FOCUS_STATE,
  type FocusState,
} from "@/lib/timeline3d/focus";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import {
  AtmosphereBackdrop,
  AtmosphereVignette,
  TIMELINE_KEYFRAMES,
} from "./atmosphere";
import { TimelineFallback } from "./timeline-fallback";
import { StrandLayer } from "./strand-layer";
import { ReadingPanel } from "./reading-panel";
import { TurnsSkeleton } from "./turns-skeleton";

export interface SceneCanvasProps {
  /** The loaded catalog window (oldest → newest); region scenes derive from
   *  it. Grows upward as the camera nears the top (§R7.4). */
  entries: TimelineSliceEntry[];
  /** Whether older catalog pages exist beyond `entries`. */
  hasMore: boolean;
  /** Prefetch trigger — fired (throttled) when the camera approaches the
   *  oldest loaded entry. */
  onNeedOlder: () => void;
  /** Slice id from `?at=` — opens at the hour level on that slice's card. */
  initialAtId?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Low-FOV shallow perspective — the 2.5D camera discipline (§5.3). The
 *  canonical value lives in regions.ts (px↔world math shares it). */
const FOV = FOV_DEG;

const BRAND_OKLCH = STRAND_PALETTE[0];
const BRAND_HEX = oklchToHex(BRAND_OKLCH);
const CORE_HEX = "#0066FF"; // the core timeline — brand blue (user-specified)

/** Scroll: world units per wheel deltaY px, scaled by camera distance. */
const SCROLL_PER_PX = 0.0016;
/** Zoom: the gesture STEPS between levels — Ctrl+wheel / pinch delta
 *  accumulates into a step at this many px. */
const ZOOM_STEP_PX = 120;
const PINCH_STEP_PX = 90;
/** Idle this long and the accumulated zoom delta resets (a new gesture). */
const ZOOM_ACCUM_IDLE_MS = 350;
/** Rotate: radians per drag px; clamps the exploratory orbit. */
const ROTATE_PER_PX = 0.005;
const ROTATE_MAX = 1.1;
/** A tap under this many px of travel still counts as a tap. */
const TAP_SLOP_PX = 12;

/** Window probes (region cards / labels) re-evaluate at this cadence. */
const PROBE_MS = 200;

// ─── Shared mutable view state (written by the rig, read by LOD layers) ────

export interface ViewState {
  camY: number;
  /** The camera's flight target — a probe that finds nothing mid-flight keeps
   *  its stale windows instead of blanking the scene (level-switch gap). */
  camYT: number;
  /** True from a zoom step (or drill) until the flight arrives. While flying,
   *  window probes are frozen: every probe update re-renders each drei Html
   *  root (createRoot + render), and under the per-frame flight load those
   *  concurrent renders starve and the DOM flashes empty — the stale windows
   *  are world-positioned and track the easing camera, so freezing is
   *  invisible and the refill lands once on arrival. */
  levelFlight: boolean;
  /** The target zoom level — content derives from this, never from the
   *  easing camera distance. */
  level: ZoomLevel;
  zs: RegionZoomState;
  azimuth: number;
  visibleHalf: number;
}

/** Shared tap/drag disambiguation between the gesture rig and DOM clicks. */
interface InteractionState {
  suppressClick: boolean;
}

/**
 * Translated strings for components inside the R3F tree. The Canvas renders
 * through its own reconciler root and next-intl context does NOT reliably
 * cross it (HourCard crashed with "context not found" on level switches) —
 * the established discipline is to hoist every `useTranslations` call to the
 * SceneCanvas root (outside Canvas) and pass strings down as props.
 */
interface TimelineLabels {
  decisions: string;
  openLoops: string;
  turns: (count: number) => string;
  continues: string;
  turnsUser: string;
  turnsAgent: string;
  turnsClose: string;
  turnsLoading: string;
  turnsFailed: string;
  turnsOpen: string;
  nowLabel: string;
  nowSub: string;
}

/** A pending drill-down: the rig steps to `level` and flies camY to `y`. */
interface DrillTarget {
  level: ZoomLevel;
  y: number;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

/** "HH:MM" local time; "" for unparseable input. */
function hhmm(iso: string | undefined): string {
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

// ─── Camera + gesture rig ──────────────────────────────────────────────────

function CameraRig({
  scenes,
  initialY,
  initialLevel,
  viewRef,
  interactionRef,
  drillRef,
  focus,
  onTraverse,
  hasMore,
  onNeedOlder,
}: {
  scenes: RegionScene[];
  initialY: number;
  initialLevel: ZoomLevel;
  viewRef: React.MutableRefObject<ViewState>;
  interactionRef: React.MutableRefObject<InteractionState>;
  drillRef: React.MutableRefObject<DrillTarget | null>;
  focus: FocusState;
  /** Fire the hour→chat traverse for a slice id. */
  onTraverse: (sliceId: string) => void;
  /** Catalog window state (§R7.4) — read through refs, never stale. */
  hasMore: boolean;
  onNeedOlder: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  const camY = useRef(initialY);
  const camYT = useRef(initialY);
  // The level is the state; the camera distance only eases toward it.
  const levelT = useRef<ZoomLevel>(initialLevel);
  const dist = useRef(regionZoomState(initialLevel).distance);
  /** Set by a zoom step/drill, cleared when the flight arrives (±timeout). */
  const levelFlight = useRef(false);
  const levelFlightAt = useRef(0);
  const zoomAccum = useRef(0);
  const zoomAccumAt = useRef(0);
  const azimuth = useRef(0);
  const rotating = useRef(false);

  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onTraverseRef = useRef(onTraverse);
  onTraverseRef.current = onTraverse;
  // Scene bounds change with the level and with responsive relayout — read
  // the live array through a ref so the gesture handlers never go stale.
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const boundsFor = (level: ZoomLevel) => {
    const s = scenesRef.current[level];
    return { yMin: s.nowY - 3, yMax: s.yTop + 4 };
  };

  // Catalog-window paging (§R7.4): read through refs so the per-frame edge
  // check never goes stale; the fetch itself is throttled to 1/s.
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const onNeedOlderRef = useRef(onNeedOlder);
  onNeedOlderRef.current = onNeedOlder;
  const lastNeedOlderAt = useRef(0);

  // A catalog prepend (or a responsive relayout) rebuilds every scene with
  // shifted Y coordinates — re-anchor the camera on the same slice so the
  // world never jumps out from under the user.
  const prevScenesRef = useRef(scenes);
  useEffect(() => {
    const prev = prevScenesRef.current;
    prevScenesRef.current = scenes;
    if (prev === scenes) return;
    const anchor = nearestSliceAtY(prev[levelT.current], camYT.current);
    if (!anchor) return;
    const oldPos = findSlicePosition(prev[levelT.current], anchor.id);
    const newPos = findSlicePosition(scenes[levelT.current], anchor.id);
    if (!oldPos || !newPos) return;
    const deltaY = newPos[1] - oldPos[1];
    if (deltaY !== 0) {
      camY.current += deltaY;
      camYT.current += deltaY;
    }
  }, [scenes]);

  // Opening the focus card flies straight to the hour level (§R7.3).
  const prevFocusMode = useRef(focus.mode);
  useEffect(() => {
    if (focus.mode === "focus" && prevFocusMode.current !== "focus") {
      levelT.current = MAX_ZOOM_LEVEL;
    }
    prevFocusMode.current = focus.mode;
  }, [focus.mode]);

  /** One deliberate zoom step. Zooming in past hour while focused traverses
   *  into the chat ("推近到底"). The step re-anchors the camera: the target
   *  level re-lays the scene out at a different scale, so a kept world y
   *  would map to a different time — recenter on the nearest slice instead. */
  const stepZoom = useCallback((dir: 1 | -1) => {
    let next: ZoomLevel;
    if (dir > 0) {
      if (levelT.current >= MAX_ZOOM_LEVEL) {
        if (focusRef.current.mode === "focus") {
          onTraverseRef.current(focusRef.current.sliceId);
        }
        return;
      }
      next = (levelT.current + 1) as ZoomLevel;
    } else {
      if (levelT.current === 0) return;
      next = (levelT.current - 1) as ZoomLevel;
    }
    const anchor = nearestSliceAtY(
      scenesRef.current[levelT.current],
      camYT.current,
    );
    levelT.current = next;
    levelFlight.current = true;
    levelFlightAt.current = performance.now();
    if (anchor) {
      const pos = findSlicePosition(scenesRef.current[next], anchor.id);
      if (pos) camYT.current = pos[1];
    }
  }, []);

  /** Accumulate a zoom gesture delta; fire one step per threshold crossing. */
  const accumulateZoom = useCallback(
    (delta: number) => {
      const now = performance.now();
      if (now - zoomAccumAt.current > ZOOM_ACCUM_IDLE_MS) zoomAccum.current = 0;
      zoomAccumAt.current = now;
      zoomAccum.current += delta;
      if (Math.abs(zoomAccum.current) >= ZOOM_STEP_PX) {
        stepZoom(zoomAccum.current > 0 ? 1 : -1);
        zoomAccum.current = 0;
      }
    },
    [stepZoom],
  );

  useEffect(() => {
    const el = gl.domElement;
    // Wheel rides the R3F container (canvas parent), not the canvas itself:
    // drei Html overlays (region/focus cards) sit above the canvas and would
    // otherwise swallow wheel gestures. A card region marked data-tl-scroll
    // that can actually scroll further keeps its native scroll.
    const wheelEl = (el.parentElement as HTMLElement | null) ?? el;

    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target !== el) {
        const scroller = target.closest?.("[data-tl-scroll]") as HTMLElement | null;
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
          const up = e.deltaY < 0;
          const atTop = scroller.scrollTop <= 0;
          const atBottom =
            scroller.scrollTop + scroller.clientHeight >=
            scroller.scrollHeight - 1;
          if ((up && !atTop) || (!up && !atBottom)) return; // card scrolls
        }
      }
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch on a trackpad arrives as ctrl+wheel. Zoom = level steps.
        accumulateZoom(-e.deltaY);
      } else {
        // Wheel down → toward now (y decreases).
        const speed = viewRef.current.zs.distance * SCROLL_PER_PX;
        const { yMin, yMax } = boundsFor(viewRef.current.level);
        camYT.current = THREE.MathUtils.clamp(
          camYT.current - e.deltaY * speed,
          yMin,
          yMax,
        );
      }
    };

    // Rotation drag: Alt+left-drag or right-drag (§5.2 gesture table).
    const onPointerDown = (e: PointerEvent) => {
      if (e.altKey || e.button === 2) {
        rotating.current = true;
        interactionRef.current.suppressClick = true;
        lastX = e.clientX;
        window.addEventListener("pointermove", onRotateMove);
        window.addEventListener("pointerup", onRotateEnd, { once: true });
      }
    };
    let lastX = 0;
    const onRotateMove = (e: PointerEvent) => {
      azimuth.current = THREE.MathUtils.clamp(
        azimuth.current + (e.clientX - lastX) * ROTATE_PER_PX,
        -ROTATE_MAX,
        ROTATE_MAX,
      );
      lastX = e.clientX;
    };
    const onRotateEnd = () => {
      rotating.current = false;
      window.removeEventListener("pointermove", onRotateMove);
      setTimeout(() => {
        interactionRef.current.suppressClick = false;
      }, 60);
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    // Touch: 1 finger = vertical time travel; 2 fingers = pinch zoom +
    // rotation.
    let swiping = false;
    let lastY = 0;
    let startX = 0;
    let travel = 0;
    let pinchD = 0;
    let pinchAngle = 0;

    const touchAngle = (t: TouchList) =>
      Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
    const touchDist = (t: TouchList) =>
      Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        swiping = true;
        const t = e.touches[0];
        lastY = t.clientY;
        startX = t.clientX;
        travel = 0;
      } else if (e.touches.length === 2) {
        swiping = false;
        pinchD = touchDist(e.touches);
        pinchAngle = touchAngle(e.touches);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      // The scene owns vertical gestures; block page scroll/pull-to-refresh.
      e.preventDefault();
      if (e.touches.length === 1 && swiping) {
        const t = e.touches[0];
        const dy = lastY - t.clientY; // swipe up = toward now
        lastY = t.clientY;
        travel += Math.abs(dy) + Math.abs(t.clientX - startX) * 0.2;
        if (travel > TAP_SLOP_PX) interactionRef.current.suppressClick = true;
        const speed = viewRef.current.zs.distance * SCROLL_PER_PX * 1.5;
        const { yMin, yMax } = boundsFor(viewRef.current.level);
        camYT.current = THREE.MathUtils.clamp(camYT.current - dy * speed, yMin, yMax);
      } else if (e.touches.length === 2 && pinchD > 0) {
        const d = touchDist(e.touches);
        accumulateZoom((d - pinchD) * (ZOOM_STEP_PX / PINCH_STEP_PX));
        pinchD = d;
        const a = touchAngle(e.touches);
        azimuth.current = THREE.MathUtils.clamp(
          azimuth.current + (a - pinchAngle),
          -ROTATE_MAX,
          ROTATE_MAX,
        );
        pinchAngle = a;
        rotating.current = true; // hold until touchend
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        rotating.current = false;
        pinchD = 0;
        swiping = false;
        setTimeout(() => {
          interactionRef.current.suppressClick = false;
        }, 60);
      }
    };

    wheelEl.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      wheelEl.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("pointermove", onRotateMove);
    };
  }, [gl, viewRef, interactionRef, accumulateZoom]);

  useFrame((_, delta) => {
    // A drill-down (card click on week/day) steps the level and flies the
    // camera to the slice's card in the deeper scene in the same gesture.
    if (drillRef.current) {
      levelT.current = drillRef.current.level;
      camYT.current = drillRef.current.y;
      drillRef.current = null;
      levelFlight.current = true;
      levelFlightAt.current = performance.now();
    }
    const { yMin, yMax } = boundsFor(levelT.current);
    camYT.current = THREE.MathUtils.clamp(camYT.current, yMin, yMax);
    // The camera eases toward the level's fixed distance; content already
    // switched to the target level when the gesture stepped.
    const targetDist = regionZoomState(levelT.current).distance;
    dist.current = THREE.MathUtils.damp(dist.current, targetDist, 4, delta);
    camY.current = THREE.MathUtils.damp(camY.current, camYT.current, 5, delta);
    // The window-probe freeze lifts when the flight arrives — or after 1.5s
    // regardless, so a pathological flight can never freeze the scene.
    if (
      levelFlight.current &&
      ((Math.abs(camY.current - camYT.current) < 0.3 &&
        Math.abs(dist.current - targetDist) < 0.3) ||
        performance.now() - levelFlightAt.current > 1500)
    ) {
      levelFlight.current = false;
    }
    // Exploratory rotation slowly re-centers once released (§5.2).
    if (!rotating.current) {
      azimuth.current = THREE.MathUtils.damp(azimuth.current, 0, 1.8, delta);
    }
    // Approaching the oldest loaded entry (the scene top) with more history
    // on the server → prefetch the previous catalog window (§R7.4).
    if (hasMoreRef.current) {
      const nowMs = performance.now();
      const sceneTop = scenesRef.current[levelT.current].yTop;
      const margin = Math.max(
        10,
        Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * dist.current * 3,
      );
      if (
        camYT.current > sceneTop - margin &&
        nowMs - lastNeedOlderAt.current > 1000
      ) {
        lastNeedOlderAt.current = nowMs;
        onNeedOlderRef.current();
      }
    }
    const zs = regionZoomState(levelT.current);
    const d = dist.current;
    const az = azimuth.current;
    // Spine-left layout (v0.10 Rev 6): translate the whole frame right so the
    // spine renders at a fixed screen-x fraction (≈18% desktop / ≈10% phone)
    // and the cards own the wide right field. The orbit still circles the
    // spine — this is a rigid lateral shift of both eye and target.
    const aspect = (camera as THREE.PerspectiveCamera).aspect || 1;
    const halfW =
      Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * d * aspect;
    const spineFrac = size.width < 768 ? 0.1 : 0.18;
    const xOff = (1 - 2 * spineFrac) * halfW;
    camera.position.set(Math.sin(az) * d + xOff, camY.current, Math.cos(az) * d);
    camera.lookAt(coreXAt(camY.current) * 0.6 + xOff, camY.current, 0);
    viewRef.current = {
      camY: camY.current,
      camYT: camYT.current,
      levelFlight: levelFlight.current,
      level: levelT.current,
      zs,
      azimuth: az,
      visibleHalf: Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * d,
    };
  });

  return null;
}

// ─── Core line ─────────────────────────────────────────────────────────────

// The spine: one straight brand-blue vertical from just above the oldest
// region down into the NOW point (Rev 7 — region boundary ticks, not nodes,
// mark it).
function CoreLine({ scene }: { scene: RegionScene }) {
  const points = useMemo<[number, number, number][]>(
    () => [
      [coreXAt(scene.yTop + 2), scene.yTop + 2, 0],
      scene.nowPosition,
    ],
    [scene],
  );

  // One flat brand-blue stroke, no glow underlay (user direction 2026-09-06 —
  // the spine reads cleaner flat on both themes).
  return (
    <DreiLine
      points={points}
      color={CORE_HEX}
      lineWidth={2}
      toneMapped={false}
      raycast={() => null}
    />
  );
}

// ─── Region ticks (instanced squares on the spine) ─────────────────────────

// Rev 7: per-node squares are gone — each REGION gets one small square on the
// spine at its first-row midline (originY). The squares are screen-space
// marks (scaled by camera distance, billboarded), pure orientation aids;
// interaction lives on the DOM cards.
function RegionTicks({
  scene,
  viewRef,
}: {
  scene: RegionScene;
  viewRef: React.MutableRefObject<ViewState>;
}) {
  const camera = useThree((s) => s.camera);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { geometry, material } = useMemo(
    () => ({
      geometry: new THREE.PlaneGeometry(2, 2),
      material: new THREE.MeshBasicMaterial({
        color: CORE_HEX,
        toneMapped: false,
      }),
    }),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const lastDist = useRef(-1);
  const lastAz = useRef(0);
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const v = viewRef.current;
    const dist = v.zs.distance;
    if (
      Math.abs(dist - lastDist.current) / Math.max(dist, 1) < 0.01 &&
      Math.abs(v.azimuth - lastAz.current) < 0.01
    ) {
      return;
    }
    lastDist.current = dist;
    lastAz.current = v.azimuth;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const quat = camera.quaternion;
    // Screen-space constant: ≈10px edge at any level distance.
    const s = Math.max(dist * 0.0025, 0.0001);
    scene.regions.forEach((region, i) => {
      pos.set(coreXAt(region.originY), region.originY, 0);
      sc.set(s, s, s);
      m.compose(pos, quat, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (scene.regions.length === 0) return null;
  return (
    <instancedMesh
      key={scene.regions.length}
      ref={meshRef}
      args={[geometry, material, scene.regions.length]}
      raycast={() => null}
    />
  );
}

// ─── The traveling beam (§5.0: the only autonomous motion besides NOW) ─────

function Beam({ scene, dark }: { scene: RegionScene; dark: boolean }) {
  const ref = useRef<THREE.Sprite>(null);
  const material = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    // Light theme uses normal blending + brand blue — additive pale blue
    // disappears against a light page background.
    const rgb = dark ? "147,165,255" : "0,102,255";
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(0.5, `rgba(${rgb},${dark ? 0.9 : 0.55})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 128);
    return new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
  }, [dark]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }) => {
    const sp = ref.current;
    if (!sp) return;
    const t = (clock.elapsedTime % 4.5) / 4.5;
    const y = scene.yTop + 2 - t * (scene.yTop - scene.nowY + 4);
    sp.position.set(coreXAt(y), y, 0.05);
    material.opacity = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.5;
  });

  return <sprite ref={ref} material={material} scale={[0.5, 2.4, 1]} />;
}

// ─── Card building blocks ──────────────────────────────────────────────────

/** The scene's punctuation mark: a tiny sharp-cornered square (site motif). */
function ColorSquare({
  color,
  className = "size-1.5",
}: {
  color: string;
  className?: string;
}) {
  // Sharp corners — the site's signature punctuation square and the spine
  // ticks are both hard-edged; the card echoes them.
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 ${className}`}
      style={{ backgroundColor: color }}
    />
  );
}

const cardPreviewCache = new Map<string, SliceContent | null>();

function CardTurnsPreview({
  sliceId,
  labels,
}: {
  sliceId: string;
  /** Resolved outside the Html portal — next-intl context doesn't cross it. */
  labels: { user: string; agent: string };
}) {
  const [content, setContent] = useState<SliceContent | null | undefined>(
    cardPreviewCache.get(sliceId),
  );
  useEffect(() => {
    if (content !== undefined) return;
    let cancelled = false;
    getSliceContent(sliceId)
      .then((c) => {
        cardPreviewCache.set(sliceId, c);
        if (!cancelled) setContent(c);
      })
      .catch(() => {
        cardPreviewCache.set(sliceId, null);
        if (!cancelled) setContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sliceId, content]);
  // Loading: the skeleton holds the preview's shape. Failed stays silent.
  if (content === undefined) {
    return (
      <div className="mt-2 border-t border-border/60 pt-2">
        <TurnsSkeleton />
      </div>
    );
  }
  if (!content || content.turns.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
      {content.turns.slice(0, 3).map((turn, i) => {
        const isUser = turn.role === "user";
        return (
          <p
            key={`${turn.turnId ?? "turn"}-${i}`}
            className="line-clamp-2 text-[10.5px] leading-snug text-foreground/70"
          >
            <span
              className={`mr-1.5 font-mono text-[9px] uppercase tracking-[0.14em] ${
                isUser
                  ? "font-semibold text-foreground/85"
                  : "text-muted-foreground"
              }`}
            >
              {isUser ? labels.user : labels.agent}
            </span>
            {firstLine(turn.content)}
          </p>
        );
      })}
    </div>
  );
}

// ─── The three card templates (§R7.0: small / medium / full) ───────────────

/** 远眺 (week): the smallest recognizable card — mono eyebrow (color square +
 *  HH:MM) over a clamped title line. Fixed 144px — the pixel spec the grid
 *  slots are anchored to (§R7.2 网格铺满). */
function SmallCard({ entry }: { entry: TimelineSliceEntry }) {
  return (
    <div className="relative w-36 overflow-hidden rounded-md bg-card/80 px-2 pb-1.5 pt-1.5 ring-1 ring-foreground/10 backdrop-blur-md">
      <p className="mb-0.5 flex items-center gap-1 font-mono text-[8.5px] leading-none tracking-[0.14em] text-muted-foreground">
        <ColorSquare color={accentOf(entry)} className="size-1.5" />
        {hhmm(entry.start)}
      </p>
      <p className="line-clamp-1 text-[11px] leading-tight text-card-foreground">
        {entry.focus || dateTimeLabel(entry)}
      </p>
    </div>
  );
}

/** 俯瞰 (day): mono eyebrow (HH:MM + color square) + two-line serif title +
 *  a quiet row of strand dots (≤4, no text). */
function MediumCard({ entry }: { entry: TimelineSliceEntry }) {
  const dots = entry.strands.slice(0, 4);
  return (
    <div className="relative w-56 overflow-hidden rounded-lg bg-card/85 px-3 pb-2.5 pt-2 ring-1 ring-foreground/10 backdrop-blur-md">
      <p className="mb-1 flex items-center gap-1.5 font-mono text-[9px] leading-none tracking-[0.16em] text-muted-foreground">
        <ColorSquare color={accentOf(entry)} className="size-1.5" />
        {hhmm(entry.start)}
      </p>
      <p className="line-clamp-2 font-serif text-[13.5px] leading-snug tracking-tight text-card-foreground">
        {entry.focus || dateTimeLabel(entry)}
      </p>
      {dots.length > 0 && (
        <p className="mt-1.5 flex items-center gap-1">
          {dots.map((name) => (
            <ColorSquare
              key={name}
              color={strandColor(name)}
              className="size-1"
            />
          ))}
        </p>
      )}
    </div>
  );
}

/** 凝视 (hour): the full stage card — the former tier-4 face, unchanged
 *  (eyebrow / serif title / chips / summary / decisions / loops / meta /
 *  turn preview with skeleton). Strand chips are inert punctuation now —
 *  the strand selection interaction is retired (§R7.6). */
function HourCard({
  entry,
  preview,
  labels,
}: {
  entry: TimelineSliceEntry;
  /** True for the single window card that earned the conversation preview. */
  preview: boolean;
  labels: TimelineLabels;
}) {
  const color = accentOf(entry);
  const start = hhmm(entry.start);
  const end = hhmm(entry.end);

  // Strands first (strand-colored), then tags (neutral) — labels dedupe.
  const seen = new Set<string>();
  const chips: { key: string; label: string; color: string | null }[] = [];
  for (const name of entry.strands) {
    if (seen.has(name)) continue;
    seen.add(name);
    chips.push({ key: `s:${name}`, label: name, color: strandColor(name) });
  }
  for (const tag of entry.tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    chips.push({ key: `t:${tag}`, label: tag, color: null });
  }

  return (
    <div className="relative w-64 overflow-hidden rounded-xl bg-card/85 px-3.5 pb-3 pt-2.5 ring-1 ring-foreground/10 backdrop-blur-xl md:w-72">
      {/* Accent hairline along the top edge — one accent per card (site
          discipline: color as punctuation, never fills). */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{ backgroundColor: color, opacity: 0.55 }}
      />

      {/* Eyebrow: mono date · time range. */}
      <p className="mb-1 flex items-center gap-1.5 font-mono text-[9px] leading-none tracking-[0.16em] text-muted-foreground">
        <ColorSquare color={color} className="size-1.5" />
        {entry.date}
        {start && (
          <span>
            &nbsp;· {start}
            {end && ` – ${end}`}
          </span>
        )}
      </p>

      {/* Serif title. */}
      <p className="font-serif text-[14.5px] leading-snug tracking-tight text-card-foreground">
        {entry.focus || entry.date}
      </p>

      {/* Quiet label line: strand squares carry the only color, all text
          stays muted mono; tags trail behind a middle dot. */}
      {chips.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] leading-tight">
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1 whitespace-nowrap"
            >
              {c.color !== null ? (
                <>
                  <ColorSquare color={c.color} className="size-1" />
                  <span className="text-muted-foreground">{c.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground/60">· {c.label}</span>
              )}
            </span>
          ))}
        </p>
      )}

      {entry.summary && (
        <p className="mt-2 font-serif text-[12.5px] leading-relaxed text-foreground/80">
          {entry.summary}
        </p>
      )}

      {entry.decisions.length > 0 && (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          <p className="font-mono text-[9px] uppercase leading-none tracking-[0.2em] text-muted-foreground/80">
            {labels.decisions}
          </p>
          <ul className="mt-1.5 space-y-1">
            {entry.decisions.map((d) => (
              <li
                key={d}
                className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/75"
              >
                <ColorSquare color={BRAND_HEX} className="mt-[5px] size-1" />
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
      {entry.open_loops.length > 0 && (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          <p className="font-mono text-[9px] uppercase leading-none tracking-[0.2em] text-muted-foreground/80">
            {labels.openLoops}
          </p>
          <ul className="mt-1.5 space-y-1">
            {entry.open_loops.map((l) => (
              <li
                key={l}
                className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground"
              >
                <ColorSquare
                  color={oklchToHex(STRAND_PALETTE[1])}
                  className="mt-[5px] size-1"
                />
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 border-t border-border/60 pt-2 font-mono text-[9.5px] leading-normal tracking-[0.1em] tabular-nums text-muted-foreground/80">
        {start && (
          <span>
            {start}
            {end && ` – ${end}`}
          </span>
        )}
        <span>· {labels.turns(entry.turn_count ?? 1)}</span>
        {entry.tone && <span>· {entry.tone}</span>}
        {entry.continues_from && <span>· {labels.continues} ↳</span>}
      </p>
      {preview && (
        <CardTurnsPreview
          sliceId={entry.id}
          labels={{ user: labels.turnsUser, agent: labels.turnsAgent }}
        />
      )}
    </div>
  );
}

// ─── Region layer (labels + grid cards, probe-windowed) ────────────────────

interface CardSlot {
  id: string;
  entry: TimelineSliceEntry;
  x: number;
  y: number;
  preview: boolean;
}

interface RegionWindow {
  key: string;
  label: string;
  originX: number;
  originY: number;
  cards: CardSlot[];
}

/**
 * Imperative bridge between the in-canvas RegionProbe and the plain-DOM
 * RegionOverlay (a Canvas sibling). Positions are pushed per frame straight
 * into element styles; content changes ride normal React state.
 *
 * Why not drei Html per card (the Rev 5/6 approach): every Html instance is
 * its own ReactDOM root. A zoom flight's end mounts ~85 card roots at once
 * and the concurrent renders starve under the continuous frameloop — cards
 * popped in 1–2s after the labels. One overlay tree renders the same content
 * in a single batched commit; per-frame tracking is imperative style writes.
 */
interface RegionOverlayApi {
  /** Replace the rendered window set (probe cadence, already deduped). */
  sync: (level: ZoomLevel, windows: RegionWindow[]) => void;
  /** Level-flight fade toggle (every frame, cheap). */
  setFlying: (flying: boolean) => void;
  /** Per-frame screen positions (CSS px) for every rendered item key. */
  applyPositions: (pos: Map<string, [number, number]>) => void;
}

/**
 * The region probe: computes the visible region windows at PROBE_MS cadence
 * (unchanged from the Rev 5 anti-vanish discipline — the window uses the
 * LARGER of the easing and the target level's half-height, ×1.6 overscan, so
 * cards never unmount mid-flight) and projects every window item's world
 * anchor to CSS pixels every frame.
 *
 * The mono region label sits in the region gap above the first row, at the
 * grid's left edge (§R7.2: 标签避开穿梭区). Within a region only the rows
 * intersecting the window render — any level keeps the DOM card count bounded
 * regardless of catalog length (§R7.4).
 */
function RegionProbe({
  scene,
  viewRef,
  focusedId,
  overlayApi,
}: {
  scene: RegionScene;
  viewRef: React.MutableRefObject<ViewState>;
  focusedId: string | null;
  overlayApi: React.MutableRefObject<RegionOverlayApi | null>;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const lastProbe = useRef(0);
  const stateRef = useRef<{
    level: ZoomLevel | null;
    windows: RegionWindow[];
    flying: boolean;
  }>({ level: null, windows: [], flying: false });
  const vec = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const v = viewRef.current;
    const st = stateRef.current;

    // Per-frame tracking: project the current windows' anchors (world → CSS
    // px) and write them into the overlay's DOM nodes. Frozen mid-flight
    // windows keep tracking the easing camera, so the freeze is invisible.
    if (st.windows.length > 0) {
      const labelY = scene.cfg.cardH / 2 + scene.cfg.regionGap * 0.45;
      const pos = new Map<string, [number, number]>();
      for (const w of st.windows) {
        vec.set(w.originX + 0.05, w.originY + labelY, 0).project(camera);
        pos.set(`label:${w.key}`, [
          (vec.x * 0.5 + 0.5) * size.width,
          (-vec.y * 0.5 + 0.5) * size.height,
        ]);
        for (const c of w.cards) {
          vec.set(c.x, c.y, 0).project(camera);
          pos.set(c.id, [
            (vec.x * 0.5 + 0.5) * size.width,
            (-vec.y * 0.5 + 0.5) * size.height,
          ]);
        }
      }
      overlayApi.current?.applyPositions(pos);
    }

    // The flight fade rides every frame (unthrottled) so the dip starts the
    // moment the gesture steps, not up to PROBE_MS late.
    if (v.levelFlight !== st.flying) {
      st.flying = v.levelFlight;
      overlayApi.current?.setFlying(v.levelFlight);
    }

    const now = performance.now();
    if (now - lastProbe.current < PROBE_MS) return;
    lastProbe.current = now;
    const level = v.level;
    const cfg = scene.cfg;
    const winHalf =
      Math.max(
        v.visibleHalf,
        Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * v.zs.distance,
      ) * 1.6;
    const yLo = v.camY - winHalf;
    const yHi = v.camY + winHalf;

    const next: RegionWindow[] = [];
    for (const region of scene.regions) {
      const top = region.originY + cfg.cardH / 2;
      if (regionBottom(region, cfg) > yHi || top < yLo) continue;
      const cards: CardSlot[] = [];
      region.grid.cards.forEach((card, i) => {
        const entry = region.entries[i];
        const y = region.originY - card.y;
        if (y < yLo - cfg.cardH || y > yHi + cfg.cardH) return;
        if (entry.id === focusedId) return;
        cards.push({
          id: entry.id,
          entry,
          x: region.originX + card.x,
          y,
          preview: false,
        });
      });
      if (cards.length > 0) {
        next.push({ key: region.key, label: region.label, originX: region.originX, originY: region.originY, cards });
      }
    }
    // Conversation preview pinning (hour level): the card nearest the camera
    // carries the turn preview until it leaves the window — it never hops
    // mid-scroll.
    if (scene.level === "hour" && next.length > 0) {
      let best: CardSlot | null = null;
      let bestD = Infinity;
      for (const w of next) {
        for (const c of w.cards) {
          const d = Math.abs(c.y - v.camY);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      if (best) best.preview = true;
    }
    const same =
      st.level === level &&
      st.windows.length === next.length &&
      st.windows.every(
        (w, i) =>
          w.key === next[i].key &&
          w.cards.length === next[i].cards.length &&
          w.cards.every(
            (c, j) =>
              c.id === next[i].cards[j].id &&
              c.preview === next[i].cards[j].preview,
          ),
      );
    if (!same) {
      // Frozen during a level flight: swapping the card set mid-flight reads
      // as a glitch; the stale windows are world-positioned and track the
      // easing camera (positions are re-projected every frame), so freezing
      // is invisible. The refill lands once on arrival.
      const frozen = v.levelFlight && st.windows.length > 0;
      if (!frozen) {
        st.level = level;
        st.windows = next;
        overlayApi.current?.sync(level, next);
      }
    }
  });

  return null;
}

/**
 * The region overlay: one plain-DOM tree (a Canvas sibling) rendering every
 * in-window label and grid card. Wrapper divs carry the imperative per-frame
 * position (translate3d + centering, written by RegionProbe through the api);
 * inner divs own the entrance animation and interactions. Items stay
 * `visibility:hidden` until their first position write lands (same frame as
 * mount in practice — useFrame runs before paint).
 */
function RegionOverlay({
  apiRef,
  onCardClick,
  interactionRef,
  labels,
}: {
  apiRef: React.MutableRefObject<RegionOverlayApi | null>;
  /** Click semantics per level: week/day drill down, hour focuses. */
  onCardClick: (sliceId: string, level: ZoomLevel) => void;
  interactionRef: React.MutableRefObject<InteractionState>;
  labels: TimelineLabels;
}) {
  const [windows, setWindows] = useState<RegionWindow[]>([]);
  const [windowLevel, setWindowLevel] = useState<ZoomLevel | null>(null);
  const [flying, setFlying] = useState(false);
  const elsRef = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    apiRef.current = {
      sync: (level, next) => {
        setWindowLevel(level);
        setWindows(next);
      },
      setFlying,
      applyPositions: (pos) => {
        for (const [key, p] of pos) {
          const el = elsRef.current.get(key);
          if (!el) continue;
          // Labels left-align at their anchor and center vertically; cards
          // center on their anchor (the strand through-point is the card
          // center — the line must pass under the card, §R7.2).
          el.style.transform = key.startsWith("label:")
            ? `translate3d(${p[0]}px, ${p[1]}px, 0) translateY(-50%)`
            : `translate3d(${p[0]}px, ${p[1]}px, 0) translate(-50%, -50%)`;
          el.style.visibility = "visible";
        }
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  const register = (key: string) => (el: HTMLElement | null) => {
    if (el) elsRef.current.set(key, el);
    else elsRef.current.delete(key);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-[25]">
      {windows.map((w) => (
        <div
          key={`label:${w.key}`}
          ref={register(`label:${w.key}`)}
          className="absolute left-0 top-0"
          style={{ visibility: "hidden" }}
        >
          {/* The label sits in the region gap above the first row, vertically
              centered on its anchor, left-aligned at the grid's left edge.
              The chip backdrop lifts the text off the strand lanes that share
              the gap band (return/gate runs pass behind it). */}
          <div
            className="pl-0.5 text-left select-none transition-opacity duration-150"
            style={{ opacity: flying ? 0 : 1 }}
          >
            <div className="inline-block whitespace-nowrap rounded-sm bg-background/70 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-muted-foreground backdrop-blur-sm">
              {w.label}
            </div>
          </div>
        </div>
      ))}
      {windows.map((w) =>
        w.cards.map((slot, idx) => {
          const entry = slot.entry;
          return (
            <div
              key={slot.id}
              ref={register(slot.id)}
              className="absolute left-0 top-0 z-[1]"
              style={{ visibility: "hidden" }}
            >
              <div
                role="button"
                tabIndex={0}
                className={`tl-card-in pointer-events-auto cursor-pointer select-none${flying ? " tl-flying" : ""}`}
                style={{ animationDelay: `${Math.min(idx, 5) * 45}ms` }}
                onClick={(e) => {
                  // A card click must never reach the canvas' pointer-missed
                  // handler (which would clear the focus we just set).
                  e.stopPropagation();
                  if (interactionRef.current.suppressClick) return;
                  if (windowLevel === null) return;
                  onCardClick(slot.id, windowLevel);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  if (windowLevel === null) return;
                  onCardClick(slot.id, windowLevel);
                }}
              >
                {/* Card chrome follows `windowLevel`, not `scene.level`: the
                    windows + click semantics ride the probe state, which is
                    frozen at the old level for the whole level flight while
                    `scene` flips to the target level at the gesture's start.
                    Rendering by scene.level would show hour cards whose click
                    still drills (stale windowLevel) — see §R7.5. */}
                {windowLevel === 0 && <SmallCard entry={entry} />}
                {windowLevel === 1 && <MediumCard entry={entry} />}
                {windowLevel === 2 && (
                  <HourCard entry={entry} preview={slot.preview} labels={labels} />
                )}
              </div>
            </div>
          );
        }),
      )}
    </div>
  );
}

// ─── Focused slice: the glass card (hour level) ────────────────────────────
//
// The in-scene anchor only: header / summary / strands / traverse. The full
// turn flow moved to the right-docked ReadingPanel (§R7.3) — two reading
// surfaces showing the same turns was redundant.

function FocusCard({
  entry,
  position,
  onClose,
  onTraverse,
  labels,
}: {
  entry: TimelineSliceEntry;
  /** World position of the slice's hour-level card center. */
  position: [number, number];
  onClose: () => void;
  onTraverse: (sliceId: string) => void;
  labels: TimelineLabels;
}) {
  // One accent per card: the first strand's color (grey when strandless).
  const accent = accentOf(entry);

  return (
    <Html
      position={[position[0] + 1.0, position[1], 0]}
      zIndexRange={[28, 0]}
    >
      <div className="tl-card-in relative w-72 overflow-hidden rounded-xl bg-popover/95 ring-1 ring-foreground/10 backdrop-blur-md md:w-80">
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{ backgroundColor: accent, opacity: 0.55 }}
        />
        <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="mb-1 flex items-center gap-1.5 font-mono text-[9px] leading-none tracking-[0.16em] text-muted-foreground">
              <ColorSquare color={accent} className="size-1.5" />
              {entry.date}
            </p>
            {entry.focus && (
              <p className="line-clamp-2 font-serif text-[14px] leading-snug tracking-tight text-foreground">
                {entry.focus}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={labels.turnsClose}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {entry.summary && (
          <p className="line-clamp-4 px-3.5 py-2.5 font-serif text-[12px] leading-relaxed text-foreground/80">
            {entry.summary}
          </p>
        )}

        {(entry.strands.length > 0 || entry.tags.length > 0) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 pb-2.5 font-mono text-[10px] leading-tight">
            {entry.strands.map((name) => (
              <span
                key={`s:${name}`}
                className="inline-flex items-center gap-1 whitespace-nowrap"
              >
                <ColorSquare color={strandColor(name)} className="size-1" />
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

        {/* Hour level: the turn flow lives in the right-docked ReadingPanel
            (§R7.3) — the glass card stays the in-scene anchor. */}

        <div className="border-t border-border px-3.5 py-2.5">
          <button
            onClick={() => onTraverse(entry.id)}
            className="w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent"
            style={{ color: BRAND_HEX }}
          >
            {labels.turnsOpen} →
          </button>
        </div>
      </div>
    </Html>
  );
}

// ─── NOW convergence point (§5.0: double ring, breathing, drop-shadow) ─────

function NowPoint({
  scene,
  onEnter,
  dark,
  labels,
}: {
  scene: RegionScene;
  onEnter: () => void;
  dark: boolean;
  labels: TimelineLabels;
}) {
  // A small additive sprite so the bloom pass lifts the NOW spot in 3D too.
  const glow = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    // Light theme: normal-blended brand blue — additive pale blue vanishes
    // against the light page background.
    const rgb = dark ? "120,150,255" : "0,102,255";
    grad.addColorStop(0, `rgba(${rgb},${dark ? 0.85 : 0.5})`);
    grad.addColorStop(0.4, `rgba(${rgb},${dark ? 0.25 : 0.18})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
      opacity: dark ? 0.6 : 0.9,
    });
  }, [dark]);
  useEffect(() => () => glow.dispose(), [glow]);

  return (
    <>
      <sprite
        material={glow}
        position={scene.nowPosition}
        scale={[1.7, 1.7, 1]}
      />
      <Html position={scene.nowPosition} center zIndexRange={[26, 0]}>
        <button
          onClick={onEnter}
          className="group relative flex flex-col items-center outline-none"
          style={{
            filter: `drop-shadow(0 0 8px oklch(0.6 0.23 260 / 80%))`,
          }}
          aria-label={labels.nowLabel}
        >
          <span className="relative flex size-8 items-center justify-center">
            {/* Breathing outer ring (r14 → 28px box) */}
            <span
              aria-hidden="true"
              className="tl-now-ring absolute inset-0 rounded-full border"
              style={{
                borderColor: BRAND_OKLCH,
                animation: "tl-now-breathe 2.5s ease-in-out infinite",
              }}
            />
            {/* Inner ring (r7 → 14px) */}
            <span
              aria-hidden="true"
              className="block size-3.5 rounded-full border-2 transition-transform group-hover:scale-125"
              style={{ borderColor: BRAND_OKLCH }}
            />
          </span>
          <span className="mt-2 font-mono text-[15px] font-bold tracking-wide text-foreground">
            {labels.nowLabel}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{labels.nowSub}</span>
        </button>
      </Html>
    </>
  );
}

// ─── Scene content (resolves the current level's region scene) ─────────────

// Content switches on the TARGET level the moment the gesture steps — the
// camera eases behind it (§R5.1 discipline, carried into Rev 7). One probe
// per frame keeps the React tree on the rig's level.
function SceneContent({
  scenes,
  viewRef,
  focusedId,
  onCardClick,
  onEnterNow,
  interactionRef,
  overlayApi,
  dark,
  labels,
}: {
  scenes: RegionScene[];
  viewRef: React.MutableRefObject<ViewState>;
  focusedId: string | null;
  onCardClick: (sliceId: string, level: ZoomLevel) => void;
  onEnterNow: () => void;
  interactionRef: React.MutableRefObject<InteractionState>;
  overlayApi: React.MutableRefObject<RegionOverlayApi | null>;
  dark: boolean;
  labels: TimelineLabels;
}) {
  const [level, setLevel] = useState<ZoomLevel>(() => viewRef.current.level);
  useFrame(() => {
    const l = viewRef.current.level;
    setLevel((prev) => (prev === l ? prev : l));
  });
  const scene = scenes[level];

  return (
    <>
      <CoreLine scene={scene} />
      <RegionTicks scene={scene} viewRef={viewRef} />
      <Beam scene={scene} dark={dark} />
      <StrandLayer scene={scene} viewRef={viewRef} />
      <Sparkles
        count={46}
        scale={[14, scene.yTop - scene.nowY + 12, 8]}
        position={[0, (scene.yTop + scene.nowY) / 2, 0]}
        size={1.6}
        speed={0.12}
        opacity={0.4}
        color={dark ? "#aebbdd" : "#8aa8dd"}
      />
      <RegionProbe
        scene={scene}
        viewRef={viewRef}
        focusedId={focusedId}
        overlayApi={overlayApi}
      />
      <NowPoint scene={scene} onEnter={onEnterNow} dark={dark} labels={labels} />
    </>
  );
}

// ─── The scene ─────────────────────────────────────────────────────────────

export default function SceneCanvas({
  entries,
  hasMore,
  onNeedOlder,
  initialAtId,
}: SceneCanvasProps) {
  const t = useTranslations("timeline3d");
  const tNow = useTranslations("timeline3d.now");
  // All strings consumed INSIDE the Canvas tree are hoisted here — next-intl
  // context does not reliably cross the R3F reconciler root (see
  // TimelineLabels above).
  const labels = useMemo<TimelineLabels>(
    () => ({
      decisions: t("card.decisions"),
      openLoops: t("card.openLoops"),
      turns: (count: number) => t("card.turns", { count }),
      continues: t("card.continues"),
      turnsUser: t("turns.user"),
      turnsAgent: t("turns.agent"),
      turnsClose: t("turns.close"),
      turnsLoading: t("turns.loading"),
      turnsFailed: t("turns.failed"),
      turnsOpen: t("turns.open"),
      nowLabel: tNow("label"),
      nowSub: tNow("sub"),
    }),
    [t, tNow],
  );
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  // Canvas-drawn sprites can't read CSS vars — thread the resolved theme
  // down to the texture painters (DOM cards use semantic classes instead).
  const dark = resolvedTheme !== "light";
  const [focus, dispatch] = useReducer(focusReducer, INITIAL_FOCUS_STATE);
  const [content, setContent] = useState<SliceContent | null>(null);
  const [contentState, setContentState] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [traverseTo, setTraverseTo] = useState<string | "now" | null>(null);

  // The cards-per-row is a JS concern only because it feeds 3D scene math
  // (grid widths in world units, pixel-anchored via levelConfigFor) — the
  // canvas fills the window, so window size stands in for it. DOM card
  // styling stays pure CSS.
  const [canvasW, setCanvasW] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [canvasH, setCanvasH] = useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  useEffect(() => {
    const onResize = () => {
      setCanvasW(window.innerWidth);
      setCanvasH(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // All three region scenes precomputed — a level switch (or a drill) is a
  // pure lookup, never a layout wait.
  const scenes = useMemo<RegionScene[]>(
    () =>
      ([0, 1, 2] as ZoomLevel[]).map((z) => {
        const region = ZOOM_REGIONS[z];
        const cfg = levelConfigFor(region, canvasH);
        return computeRegionScene(
          entries,
          region,
          perRowForWidth(canvasW, canvasH, region),
          cfg,
        );
      }),
    [entries, canvasW, canvasH],
  );

  // Landing: the day level (俯瞰) near NOW; a deep link (?at=) opens at the
  // hour level, centered on the linked slice's card.
  const initial = useMemo(() => {
    let camY = scenes[1].nowY + NOW_GAP + 1;
    let level: ZoomLevel = 1;
    if (initialAtId) {
      const pos = findSlicePosition(scenes[2], initialAtId);
      if (pos) {
        camY = pos[1];
        level = 2;
      }
    }
    return { camY, level };
  }, [scenes, initialAtId]);

  const viewRef = useRef<ViewState>({
    camY: initial.camY,
    camYT: initial.camY,
    levelFlight: false,
    level: initial.level,
    zs: regionZoomState(initial.level),
    azimuth: 0,
    visibleHalf: 20,
  });
  const interactionRef = useRef<InteractionState>({ suppressClick: false });
  const drillRef = useRef<DrillTarget | null>(null);
  // Bridge between the in-canvas region probe and the DOM overlay below.
  const overlayApiRef = useRef<RegionOverlayApi | null>(null);

  const isTouch = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  const focusedSliceId = focus.mode === "focus" ? focus.sliceId : null;
  const focusedEntry = useMemo(
    () => entries.find((e) => e.id === focusedSliceId) ?? null,
    [entries, focusedSliceId],
  );
  // The focus card anchors to the slice's hour-level card position (focus
  // only exists at the hour level — the rig flies there on FOCUS).
  const focusedPos = useMemo(
    () =>
      focusedSliceId ? findSlicePosition(scenes[2], focusedSliceId) : null,
    [scenes, focusedSliceId],
  );

  // Turn data loads only when a slice is focused.
  useEffect(() => {
    if (!focusedSliceId) {
      setContent(null);
      setContentState("idle");
      return;
    }
    let cancelled = false;
    setContent(null);
    setContentState("loading");
    getSliceContent(focusedSliceId)
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setContentState(c ? "ready" : "failed");
      })
      .catch(() => {
        if (!cancelled) setContentState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [focusedSliceId]);

  // Click = drill down the question chain (§R7.3): week/day cards fly the
  // camera one level deeper onto the slice's sub-region; hour cards focus.
  const handleCardClick = useCallback(
    (sliceId: string, level: ZoomLevel) => {
      if (level >= MAX_ZOOM_LEVEL) {
        dispatch({ type: "FOCUS", sliceId });
        return;
      }
      const next = (level + 1) as ZoomLevel;
      const pos = findSlicePosition(scenes[next], sliceId);
      drillRef.current = {
        level: next,
        y: pos ? pos[1] : viewRef.current.camY,
      };
    },
    [scenes],
  );

  const startTraverse = useCallback(
    (sliceId: string) => setTraverseTo((cur) => cur ?? sliceId),
    [],
  );
  const enterNow = useCallback(() => setTraverseTo((cur) => cur ?? "now"), []);

  // Esc (capture): close the focus card; the consumed press must not reach
  // the overlay's close-route listener on window.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (focus.mode === "focus") {
        e.stopPropagation();
        dispatch({ type: "EXIT" });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focus]);

  if (entries.length === 0) {
    return <TimelineFallback state="empty" />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <style>{TIMELINE_KEYFRAMES}</style>
      <AtmosphereBackdrop />

      <div className="absolute inset-0">
        <Canvas
          camera={{
            position: [
              0,
              initial.camY,
              regionZoomState(initial.level).distance,
            ],
            fov: FOV,
            near: 0.1,
            far: 500,
          }}
          gl={{ antialias: true, alpha: true }}
          dpr={[1, 2]}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          onPointerMissed={() => {
            if (interactionRef.current.suppressClick) return;
            // Clicking empty space clears the focus card.
            if (focus.mode === "focus") dispatch({ type: "EXIT" });
          }}
        >
          <SceneContent
            scenes={scenes}
            viewRef={viewRef}
            focusedId={focusedSliceId}
            onCardClick={handleCardClick}
            onEnterNow={enterNow}
            interactionRef={interactionRef}
            overlayApi={overlayApiRef}
            dark={dark}
            labels={labels}
          />
          {focusedEntry && focusedPos && (
            <FocusCard
              entry={focusedEntry}
              position={focusedPos}
              onClose={() => dispatch({ type: "EXIT" })}
              onTraverse={startTraverse}
              labels={labels}
            />
          )}
          <CameraRig
            scenes={scenes}
            initialY={initial.camY}
            initialLevel={initial.level}
            viewRef={viewRef}
            interactionRef={interactionRef}
            drillRef={drillRef}
            focus={focus}
            onTraverse={startTraverse}
            hasMore={hasMore}
            onNeedOlder={onNeedOlder}
          />
          <EffectComposer>
            <Bloom
              intensity={0.6}
              luminanceThreshold={0.55}
              luminanceSmoothing={0.25}
              mipmapBlur
            />
          </EffectComposer>
        </Canvas>
        {/* Region labels + grid cards: ONE plain-DOM tree positioned
            imperatively by RegionProbe (see RegionOverlayApi) — replacing the
            per-card drei Html roots that starved on zoom-flight arrival. */}
        <RegionOverlay
          apiRef={overlayApiRef}
          onCardClick={handleCardClick}
          interactionRef={interactionRef}
          labels={labels}
        />
      </div>

      <AtmosphereVignette />

      {/* Reading panel (§R7.3): the focused slice's full turn flow, docked
          right on desktop / bottom sheet on phones. Plain DOM — native
          scroll and text selection. */}
      {focusedEntry && (
        <ReadingPanel
          entry={focusedEntry}
          content={content}
          contentState={
            contentState === "ready"
              ? "ready"
              : contentState === "failed"
                ? "failed"
                : "loading"
          }
          onClose={() => dispatch({ type: "EXIT" })}
          onTraverse={startTraverse}
        />
      )}

      {/* Gesture hint — the axes are orthogonal, so say which is which. */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-40 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted-foreground/70">
        {focus.mode === "focus"
          ? isTouch
            ? t("hint.focusedTouch")
            : t("hint.focused")
          : isTouch
            ? t("hint.browseTouch")
            : t("hint.browse")}
      </div>

      {/* Traverse crossfade (hour-level "推近到底" / NOW): fade to the chat
          background, then the route becomes `/?at=<sliceId>` (or `/`). */}
      <AnimatePresence>
        {traverseTo && (
          <motion.div
            key="traverse"
            className="absolute inset-0 z-50 bg-background"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, ease: "easeInOut" }}
            onAnimationComplete={() =>
              router.push(
                traverseTo === "now"
                  ? "/"
                  : `/?at=${encodeURIComponent(traverseTo)}`,
              )
            }
          />
        )}
      </AnimatePresence>
    </div>
  );
}
