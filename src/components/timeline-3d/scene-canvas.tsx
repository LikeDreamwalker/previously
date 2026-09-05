"use client";

/**
 * The R3F scene itself — the heavy three.js bundle. Never imported directly:
 * `timeline-scene.tsx` loads it via next/dynamic with ssr:false so it stays
 * out of the first-load bundle and tree-shakes cleanly on the cloud target.
 *
 * Rev 5 (doc/design/v0.10.0-memory-viz.md §R5): the single-SPINE timeline
 * with DISCRETE zoom levels. There is exactly one timeline — the straight
 * brand-blue spine — and all information hangs off it, layered by level:
 * L0 Atlas (spine + day labels) → L1 Index (+ time labels, title/tags cards)
 * → L2 Digest (+ summary) → L3 Detail (+ decisions/loops, strand arcs)
 * → L4 Conversation (+ meta + turn preview); zooming past L4 drops into chat.
 * - Space: time runs TOP→BOTTOM (past up, now down). The spine is a straight
 *   vertical ending in the glowing NOW point (click → the chat's now).
 * - Level discipline: the zoom gesture (Ctrl+wheel / pinch) STEPS between
 *   levels — the camera eases to the level's fixed distance while content
 *   switches to the target level in the same frame (CSS reveals absorb it).
 *   Cards are pure billboards: no per-frame visual adjustment, only level
 *   state switches. Vertical scroll = camera Y (time travel). Rotation
 *   (Alt+drag / right-drag / two-finger rotate) orbits the spine and damps
 *   back to front-on on release.
 * - Strand arcs (§R5.3): at L3+ each strand is a semi-transparent CatmullRom
 *   curve through its carrier nodes on its lane offset; selecting a strand
 *   (chip or line click) raises it and sinks the rest.
 * - Glow: bloom with a high threshold and low intensity. Atmosphere
 *   (grid/vignette) is CSS outside the canvas (`atmosphere.tsx`) and follows
 *   the app theme; text is always DOM (drei Html, semantic Tailwind classes).
 *
 * The level semantics are pure (`zoomStateForLevel` in layout.ts). This file
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
  zoomStateForLevel,
  LEVEL_DISTANCES,
  MAX_ZOOM_LEVEL,
  STRAND_PALETTE,
  STRANDLESS_GREY,
  NOW_GAP,
  type TimelineLayout,
  type TimelineNodeLayout,
  type ZoomLevel,
  type ZoomState,
} from "@/lib/timeline3d/layout";
import {
  focusReducer,
  INITIAL_FOCUS_STATE,
  type FocusState,
} from "@/lib/timeline3d/focus";
import { getSliceContent, type SliceContent } from "@/lib/episodic/actions";
import { RollingField } from "@/components/chat/rolling-number";
import {
  AtmosphereBackdrop,
  AtmosphereVignette,
  TIMELINE_KEYFRAMES,
} from "./atmosphere";
import { TimelineFallback } from "./timeline-fallback";

export interface SceneCanvasProps {
  layout: TimelineLayout;
  /** Slice id from `?at=` — the camera starts at that node. */
  initialAtId?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Low-FOV shallow perspective — the 2.5D camera discipline (§5.3). */
const FOV = 26;

const BRAND_OKLCH = STRAND_PALETTE[0];
const BRAND_HEX = oklchToHex(BRAND_OKLCH);
const GREY_HEX = oklchToHex(STRANDLESS_GREY);
const CORE_HEX = "#0066FF"; // the core timeline — brand blue (user-specified)

/** Scroll: world units per wheel deltaY px, scaled by camera distance. */
const SCROLL_PER_PX = 0.0016;
/** Zoom (Rev 5): the gesture STEPS between levels — Ctrl+wheel / pinch delta
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
/** Right-swipe traverse: fast, mostly horizontal, one finger. */
const SWIPE_TRAVERSE_PX = 90;
const SWIPE_MAX_MS = 500;

/** LOD probes (cards) re-evaluate at this cadence, not per frame. */
const PROBE_MS = 200;
const MAX_CARDS = 8;

// ─── Shared mutable view state (written by the rig, read by LOD layers) ────

interface ViewState {
  camY: number;
  /** The target zoom level — content derives from this, never from the
   *  easing camera distance (Rev 5). */
  level: ZoomLevel;
  zs: ZoomState;
  azimuth: number;
  visibleHalf: number;
}

/** Shared tap/drag disambiguation between the gesture rig and R3F clicks. */
interface InteractionState {
  suppressClick: boolean;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

// ─── Camera + gesture rig ──────────────────────────────────────────────────

function CameraRig({
  layout,
  initialY,
  initialLevel,
  viewRef,
  interactionRef,
  focus,
  onTraverse,
}: {
  layout: TimelineLayout;
  initialY: number;
  initialLevel: ZoomLevel;
  viewRef: React.MutableRefObject<ViewState>;
  interactionRef: React.MutableRefObject<InteractionState>;
  focus: FocusState;
  /** Fire the L4→chat traverse for a slice id. */
  onTraverse: (sliceId: string) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const camY = useRef(initialY);
  const camYT = useRef(initialY);
  // Rev 5: the level is the state; the camera distance only eases toward it.
  const levelT = useRef<ZoomLevel>(initialLevel);
  const dist = useRef(LEVEL_DISTANCES[initialLevel]);
  const zoomAccum = useRef(0);
  const zoomAccumAt = useRef(0);
  const azimuth = useRef(0);
  const rotating = useRef(false);

  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onTraverseRef = useRef(onTraverse);
  onTraverseRef.current = onTraverse;
  const yMin = layout.nowY - 3;
  const yMax = layout.yTop + 4;

  // Clicking a node flies straight to the Conversation level (§R5.1).
  const prevFocusMode = useRef(focus.mode);
  useEffect(() => {
    if (focus.mode === "focus" && prevFocusMode.current !== "focus") {
      levelT.current = MAX_ZOOM_LEVEL;
    }
    prevFocusMode.current = focus.mode;
  }, [focus.mode]);

  /** One deliberate zoom step. Zooming in past L4 while focused traverses
   *  into the chat ("推近到底"). */
  const stepZoom = useCallback((dir: 1 | -1) => {
    if (dir > 0) {
      if (levelT.current >= MAX_ZOOM_LEVEL) {
        if (focusRef.current.mode === "focus") {
          onTraverseRef.current(focusRef.current.sliceId);
        }
        return;
      }
      levelT.current = (levelT.current + 1) as ZoomLevel;
    } else {
      levelT.current = Math.max(0, levelT.current - 1) as ZoomLevel;
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

  // Nearest node to the camera — the right-swipe traverse target when
  // nothing is focused.
  const nearestNode = useCallback(
    (y: number): TimelineNodeLayout | null => {
      let best: TimelineNodeLayout | null = null;
      let bestD = Infinity;
      for (const n of layout.nodes) {
        const d = Math.abs(n.y - y);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    },
    [layout],
  );
  const nearestRef = useRef(nearestNode);
  nearestRef.current = nearestNode;

  useEffect(() => {
    const el = gl.domElement;
    // Wheel rides the R3F container (canvas parent), not the canvas itself:
    // drei Html overlays (node/focus cards) sit above the canvas and would
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

    // Touch: 1 finger = vertical time travel (+ right-swipe traverse);
    // 2 fingers = pinch zoom + rotation.
    let swiping = false;
    let lastY = 0;
    let startX = 0;
    let startY = 0;
    let startT = 0;
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
        startY = t.clientY;
        startT = performance.now();
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
        // Right-swipe → traverse into the chat at the focused/nearest slice.
        if (swiping) {
          const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
          const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
          const fast = performance.now() - startT < SWIPE_MAX_MS;
          if (dx > SWIPE_TRAVERSE_PX && Math.abs(dy) < SWIPE_TRAVERSE_PX * 0.6 && fast) {
            const target =
              focusRef.current.mode === "focus"
                ? focusRef.current.sliceId
                : nearestRef.current(camY.current)?.id;
            if (target) onTraverseRef.current(target);
          }
        }
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
  }, [gl, viewRef, interactionRef, yMin, yMax, accumulateZoom]);

  useFrame((_, delta) => {
    // The camera eases toward the level's fixed distance; content already
    // switched to the target level when the gesture stepped (§R5.1).
    dist.current = THREE.MathUtils.damp(
      dist.current,
      LEVEL_DISTANCES[levelT.current],
      4,
      delta,
    );
    camY.current = THREE.MathUtils.damp(camY.current, camYT.current, 5, delta);
    // Exploratory rotation slowly re-centers once released (§5.2).
    if (!rotating.current) {
      azimuth.current = THREE.MathUtils.damp(azimuth.current, 0, 1.8, delta);
    }
    const zs = zoomStateForLevel(levelT.current);
    const d = dist.current;
    const az = azimuth.current;
    camera.position.set(Math.sin(az) * d, camY.current, Math.cos(az) * d);
    camera.lookAt(coreXAt(camY.current) * 0.6, camY.current, 0);
    viewRef.current = {
      camY: camY.current,
      level: levelT.current,
      zs,
      azimuth: az,
      visibleHalf: Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * d,
    };
  });

  return null;
}

// ─── Core line ─────────────────────────────────────────────────────────────

function CoreLine({ layout }: { layout: TimelineLayout }) {
  const points = useMemo<[number, number, number][]>(() => {
    const pts = layout.nodes.map((n) => n.position);
    pts.push(layout.nowPosition);
    return pts;
  }, [layout]);

  if (points.length < 2) return null;
  // Rev 3 phase 1: one flat brand-blue stroke, no glow underlay (user
  // direction 2026-09-06 — the spine reads cleaner flat on both themes).
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

// ─── Slice nodes (instanced squares) ───────────────────────────────────────

// Rev 3: nodes are sharp-cornered SQUARES, the site repo's punctuation motif
// (`.eyebrow::before`, solid brand square). Color is the only data channel:
// first-strand tint (grey when strand-less), brightness fades with age, edge
// length ∝ √turn_count. Checkpoint continuations (`continuesFrom`) render as
// HOLLOW squares — the chain reads at a glance. Two instanced meshes (filled
// / hollow); each instance billboards to the camera so squares stay square
// under the orbit gesture.
function NodeSquares({
  layout,
  viewRef,
  focusedId,
  onFocus,
  onTraverse,
  interactionRef,
}: {
  layout: TimelineLayout;
  viewRef: React.MutableRefObject<ViewState>;
  focusedId: string | null;
  onFocus: (sliceId: string) => void;
  onTraverse: (sliceId: string) => void;
  interactionRef: React.MutableRefObject<InteractionState>;
}) {
  const camera = useThree((s) => s.camera);
  const filledRef = useRef<THREE.InstancedMesh>(null);
  const hollowRef = useRef<THREE.InstancedMesh>(null);

  // Node index → filled|hollow bucket. Rebuilt only with the layout.
  const { filledIdx, hollowIdx, geometry, filledMaterial, hollowMaterial } =
    useMemo(() => {
      const filled: number[] = [];
      const hollow: number[] = [];
      layout.nodes.forEach((n, i) =>
        (n.continuesFrom ? hollow : filled).push(i),
      );
      // Hollow square: a shared white ring texture tinted by instanceColor.
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 11;
      ctx.strokeRect(6.5, 6.5, 51, 51);
      const ring = new THREE.CanvasTexture(canvas);
      return {
        filledIdx: filled,
        hollowIdx: hollow,
        geometry: new THREE.PlaneGeometry(2, 2),
        filledMaterial: new THREE.MeshBasicMaterial({ toneMapped: false }),
        hollowMaterial: new THREE.MeshBasicMaterial({
          map: ring,
          transparent: true,
          toneMapped: false,
        }),
      };
    }, [layout]);
  useEffect(
    () => () => {
      geometry.dispose();
      filledMaterial.dispose();
      hollowMaterial.dispose();
      hollowMaterial.map?.dispose();
    },
    [geometry, filledMaterial, hollowMaterial],
  );

  // §5.0 nodes are screen-space marks (≈4.5px), not world-space objects:
  // scale each instance by camera distance so a square keeps its pixel size
  // at every zoom level (2.5D discipline). Recomputed when the distance or
  // the azimuth drifted — a zoom/orbit frame is 500 matrix writes, cheap.
  const lastDist = useRef(-1);
  const lastAz = useRef(0);
  useFrame(() => {
    const filled = filledRef.current;
    const hollow = hollowRef.current;
    if (!filled || !hollow) return;
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
    const place = (mesh: THREE.InstancedMesh, indices: number[]) => {
      indices.forEach((ni, i) => {
        const node = layout.nodes[ni];
        // node.size is a 0..~0.28 norm; 0.013 maps the max to ≈7px half-edge.
        const s = Math.max(node.size * dist * 0.013, 0.0001);
        pos.set(node.position[0], node.position[1], node.position[2]);
        sc.set(s, s, s);
        m.compose(pos, quat, sc);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(filled, filledIdx);
    place(hollow, hollowIdx);
  });

  useLayoutEffect(() => {
    const filled = filledRef.current;
    const hollow = hollowRef.current;
    if (!filled || !hollow) return;
    const c = new THREE.Color();
    const grey = new THREE.Color(GREY_HEX);
    const paint = (mesh: THREE.InstancedMesh, indices: number[]) => {
      indices.forEach((ni, i) => {
        const node = layout.nodes[ni];
        // Squares keep their first-strand tint as data coloring (the strands
        // themselves are not drawn in Rev 3 phase 1).
        if (node.strands.length > 0) {
          c.set(oklchToHex(layout.strands.find((s) => s.name === node.strands[0])?.color ?? BRAND_OKLCH));
        } else {
          c.copy(grey);
        }
        c.multiplyScalar(0.45 + node.brightness * 1.2);
        if (node.id === focusedId) c.multiplyScalar(2.2);
        mesh.setColorAt(i, c);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    paint(filled, filledIdx);
    paint(hollow, hollowIdx);
  }, [layout, focusedId, filledIdx, hollowIdx]);

  const handlers = (indices: number[]) => ({
    onClick: (e: { stopPropagation: () => void; instanceId?: number }) => {
      e.stopPropagation();
      if (interactionRef.current.suppressClick) return;
      const i = e.instanceId;
      if (i !== undefined) onFocus(layout.nodes[indices[i]].id);
    },
    onDoubleClick: (e: { stopPropagation: () => void; instanceId?: number }) => {
      e.stopPropagation();
      if (interactionRef.current.suppressClick) return;
      const i = e.instanceId;
      if (i !== undefined) onTraverse(layout.nodes[indices[i]].id);
    },
    onPointerOver: () => {
      document.body.style.cursor = "pointer";
    },
    onPointerOut: () => {
      document.body.style.cursor = "auto";
    },
  });

  return (
    <>
      <instancedMesh
        ref={filledRef}
        args={[geometry, filledMaterial, filledIdx.length]}
        {...handlers(filledIdx)}
      />
      <instancedMesh
        ref={hollowRef}
        args={[geometry, hollowMaterial, hollowIdx.length]}
        {...handlers(hollowIdx)}
      />
    </>
  );
}

// ─── Date / time labels (DOM billboards, rolling digits) ───────────────────

// Labels are DOM (drei Html), not canvas sprites: crisp text on both themes,
// and the digits ride the shared odometer animation (`rolling-number.tsx`,
// the same component as the chat mode's time rail). Like NodeCards the set
// is probe-bounded — only labels near the camera exist. They hug the spine's
// LEFT side (right-aligned); the cards hug the right.
const MAX_LABELS = 10;

function RollingDate({ date }: { date: string }) {
  const [y, m, d] = date.split("-").map((s) => Number(s));
  return (
    <span className="inline-flex items-baseline">
      <RollingField value={y || 0} digits={4} />
      <span>-</span>
      <RollingField value={m || 0} />
      <span>-</span>
      <RollingField value={d || 0} />
    </span>
  );
}

function RollingTime({ start }: { start: string }) {
  const d = new Date(start);
  const ok = !Number.isNaN(d.getTime());
  return (
    <span className="inline-flex items-baseline">
      <RollingField value={ok ? d.getHours() : 0} />
      <span>:</span>
      <RollingField value={ok ? d.getMinutes() : 0} />
    </span>
  );
}

interface TimeLabelItem {
  id: string;
  y: number;
  opacity: number;
  day: boolean;
  date: string;
  start: string;
}

function TimeLabels({
  layout,
  viewRef,
  dimmedRef,
}: {
  layout: TimelineLayout;
  viewRef: React.MutableRefObject<ViewState>;
  dimmedRef: React.MutableRefObject<boolean>;
}) {
  const [items, setItems] = useState<TimeLabelItem[]>([]);
  const lastProbe = useRef(0);

  useFrame(() => {
    const now = performance.now();
    if (now - lastProbe.current < PROBE_MS) return;
    lastProbe.current = now;
    const v = viewRef.current;
    const dim = dimmedRef.current ? 0.35 : 1;
    const next: TimeLabelItem[] = [];
    for (const n of layout.nodes) {
      const d = Math.abs(n.y - v.camY);
      const prox = THREE.MathUtils.clamp(1 - d / (v.visibleHalf * 2.4), 0, 1);
      if (prox <= 0.03) continue;
      if (n.dayStart) {
        next.push({
          id: n.id,
          y: n.y,
          opacity: prox * 0.95 * dim,
          day: true,
          date: n.date,
          start: n.start,
        });
      } else if (v.zs.timePoints) {
        next.push({
          id: n.id,
          y: n.y,
          opacity: prox * 0.6 * dim,
          day: false,
          date: n.date,
          start: n.start,
        });
      }
    }
    next.sort((a, b) => Math.abs(a.y - v.camY) - Math.abs(b.y - v.camY));
    const capped = next.slice(0, MAX_LABELS);
    setItems((prev) => {
      if (
        prev.length === capped.length &&
        prev.every(
          (p, i) =>
            p.id === capped[i].id &&
            Math.abs(p.opacity - capped[i].opacity) < 0.06,
        )
      ) {
        return prev;
      }
      return capped;
    });
  });

  return (
    <>
      {items.map((it) => (
        <Html
          key={it.id}
          position={[coreXAt(it.y), it.y, 0]}
          zIndexRange={[24, 0]}
          style={{ pointerEvents: "none", opacity: it.opacity }}
        >
          <div className="-translate-x-full -translate-y-1/2 pr-3 text-right select-none">
            {it.day ? (
              <>
                <div className="whitespace-nowrap font-mono text-[13px] font-semibold tabular-nums text-muted-foreground">
                  <RollingDate date={it.date} />
                </div>
                <div className="mt-0.5 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  <RollingTime start={it.start} />
                </div>
              </>
            ) : (
              <div className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground/80">
                <RollingTime start={it.start} />
              </div>
            )}
          </div>
        </Html>
      ))}
    </>
  );
}

// ─── The traveling beam (§5.0: the only autonomous motion besides NOW) ─────

function Beam({ layout, dark }: { layout: TimelineLayout; dark: boolean }) {
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
    const y = layout.yTop + 2 - t * (layout.yTop - layout.nowY + 4);
    sp.position.set(coreXAt(y), y, 0.05);
    material.opacity = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.5;
  });

  return <sprite ref={ref} material={material} scale={[0.5, 2.4, 1]} />;
}

// ─── Node cards (bounded Html billboards, content = the level) ─────────────

// Rev 5.1 card discipline: natural height — the card grows with its CONTENT,
// never stretched to fill a band. The tier IS the zoom level; a card never
// responds to any live camera parameter. The single remaining adjustment is
// collision demotion, computed from WORLD-space gaps (layout constants) at
// the level's FIXED distance — deterministic per node per level, stable
// while the camera scrolls or eases. Tags render in full (no +N truncation):
// the column beside the spine has room.

/** The scene's punctuation mark: a tiny sharp-cornered square (site motif). */
function ColorSquare({
  color,
  className = "size-1.5",
}: {
  color: string;
  className?: string;
}) {
  // Sharp corners — the site's signature punctuation square and the 3D node
  // markers are both hard-edged; the card echoes them.
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 ${className}`}
      style={{ backgroundColor: color }}
    />
  );
}

interface CardItem {
  id: string;
  tier: 1 | 2 | 3 | 4;
  /** True for the single card that earned the T4 conversation preview. */
  preview: boolean;
}

// ── Natural-height estimation (collision budget) ───────────────────────────
// Heuristic px math for a w-64 (256px) card with px-3.5: ~228px of content.
// CJK glyphs are ~1em wide, latin ~0.55em — close enough for a tier choice.

function textUnits(s: string): number {
  let u = 0;
  for (const ch of s) u += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  return u;
}

const CARD_CONTENT_W = 228;

function estimateCardHeight(
  node: TimelineNodeLayout,
  tier: number,
  preview: boolean,
): number {
  let h = 28; // vertical padding + breathing
  const title = node.focus || node.date;
  // Serif title ~14.5px / 20px line.
  const titleLines =
    tier === 1 ? 1 : Math.max(1, Math.ceil((textUnits(title) * 14.5) / CARD_CONTENT_W));
  h += titleLines * 20;
  // Eyebrow (mono date · time) rides tiers ≥ 2.
  if (tier >= 2) h += 16;
  const labels = [...node.strands, ...node.tags];
  if (labels.length > 0) {
    let w = 0;
    let rows = 1;
    for (const label of labels) {
      const cw = textUnits(label) * 10 + 14;
      if (w > 0 && w + cw > CARD_CONTENT_W) {
        rows++;
        w = 0;
      }
      w += cw;
    }
    h += rows * 14 + 6;
  }
  if (tier >= 2 && node.summary) {
    // Serif summary ~12.5px / 20px line.
    h += Math.max(1, Math.ceil((textUnits(node.summary) * 12) / CARD_CONTENT_W)) * 20 + 8;
  }
  if (tier >= 3) {
    if (node.decisions.length > 0) h += 26; // hairline + eyebrow header
    if (node.openLoops.length > 0) h += 26;
    for (const d of [...node.decisions, ...node.openLoops]) {
      h += Math.max(1, Math.ceil((textUnits(d) * 10.5) / CARD_CONTENT_W)) * 15;
    }
    if (node.decisions.length > 0 || node.openLoops.length > 0) h += 4;
  }
  if (tier >= 4) {
    h += 18; // meta line
    if (preview) h += 78; // conversation preview block
  }
  return h;
}

// ── T4 conversation preview (lazy, cached, one card at a time) ─────────────

const cardPreviewCache = new Map<string, SliceContent | null>();

/**
 * Turn-list skeleton (§R5.2): the catalog says the slice EXISTS before its
 * turns arrive — show the shape of the incoming rows instead of silence.
 * Square punctuation + staggered pulse bars, theme-aware via bg-muted.
 */
function TurnsSkeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["88%", "72%", "58%"];
  return (
    <div aria-hidden="true" className="space-y-1.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="inline-block size-1 shrink-0 rounded-[1px] bg-muted-foreground/30" />
          <span
            className="h-2 animate-pulse rounded-full bg-muted-foreground/15"
            style={{
              width: widths[i % widths.length],
              animationDelay: `${i * 120}ms`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

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
  // Loading: the skeleton holds the preview's shape (≈ the 78px the
  // collision estimate reserves). Failed stays silent.
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

/** Level-change reveal (§R5.2): sections grow open (grid-rows 0fr→1fr +
 *  opacity) instead of popping — the level switch reads as the card
 *  breathing open. Children stay mounted both ways. */
function Reveal({
  show,
  children,
}: {
  show: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`grid transition-all duration-300 ease-out ${
        show
          ? "grid-rows-[1fr] opacity-100"
          : "grid-rows-[0fr] -translate-y-0.5 opacity-0"
      }`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

/** "HH:MM" local time for the meta line's range; "" for unparseable input. */
function hhmm(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function NodeCards({
  layout,
  viewRef,
  focusedId,
  selectedStrand,
  onSelectStrand,
}: {
  layout: TimelineLayout;
  viewRef: React.MutableRefObject<ViewState>;
  focusedId: string | null;
  /** Strand selection (§R5.3): clicking a strand chip highlights its arc. */
  selectedStrand: string | null;
  onSelectStrand: (name: string | null) => void;
}) {
  const t = useTranslations("timeline3d");
  const size = useThree((s) => s.size);
  const [items, setItems] = useState<CardItem[]>([]);
  const lastProbe = useRef(0);
  // The conversation preview is PINNED to a card until that card leaves the
  // window — it never hops mid-scroll.
  const previewIdRef = useRef<string | null>(null);

  useFrame(() => {
    const now = performance.now();
    if (now - lastProbe.current < PROBE_MS) return;
    lastProbe.current = now;
    const v = viewRef.current;
    const base = v.zs.cardTier;
    if (base === 0) {
      previewIdRef.current = null;
      setItems((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Rev 5.1: a card's tier is a function of the LEVEL ONLY — never of the
    // live camera. Collision demotion reads the WORLD-space gap to the next
    // node (a layout constant) converted to px via the level's FIXED
    // distance, so scrolling or the camera's easing flight can never change
    // a card's size. The camera only decides WHICH nodes are in the window.
    const pxPerWorld =
      size.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * v.zs.distance);
    // Cards mount for the window's nodes nearest the camera (screen-space
    // order is irrelevant — Html anchors each card to its node). The window
    // uses the LARGER of the easing and the target level's half-height:
    // during a zoom-in flight the window would otherwise shrink mid-flight
    // and unmount cards that are still on screen (the "vanishing card" bug).
    const winHalf =
      Math.max(
        v.visibleHalf,
        Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * v.zs.distance,
      ) * 1.6;
    const windowed = layout.nodes
      .filter((n) => n.id !== focusedId && Math.abs(n.y - v.camY) < winHalf)
      .sort((a, b) => Math.abs(a.y - v.camY) - Math.abs(b.y - v.camY))
      .slice(0, MAX_CARDS)
      .sort((a, b) => b.y - a.y); // y DESC for deterministic diff order
    const nodeIdx = new Map(layout.nodes.map((n, i) => [n.id, i]));
    const next: CardItem[] = [];
    const bands: number[] = [];
    for (const n of windowed) {
      // Gap to the NEXT node in the full layout (not just the window) — the
      // last node gets an unbounded budget.
      const ni = nodeIdx.get(n.id) ?? -1;
      const below = ni >= 0 ? layout.nodes[ni + 1] : undefined;
      const band = below ? (n.y - below.y) * pxPerWorld - 8 : Infinity;
      if (band < 40) continue; // crowded cluster: dot only
      let tier = base;
      while (tier > 1 && estimateCardHeight(n, tier, false) > band) tier--;
      next.push({ id: n.id, tier: tier as CardItem["tier"], preview: false });
      bands.push(band);
    }
    // Preview pinning: keep the pinned card while it stays tier-4 and fits
    // with the preview attached; otherwise pin the fittest tier-4 card
    // nearest the camera.
    let pinned = next.findIndex((it) => it.id === previewIdRef.current);
    if (pinned >= 0) {
      const node = layout.nodes.find((x) => x.id === next[pinned].id);
      if (
        next[pinned].tier < 4 ||
        !node ||
        estimateCardHeight(node, 4, true) > bands[pinned]
      ) {
        pinned = -1;
      }
    }
    if (pinned < 0) {
      let bestProx = -1;
      next.forEach((it, i) => {
        if (it.tier < 4) return;
        const node = layout.nodes.find((x) => x.id === it.id);
        if (!node || estimateCardHeight(node, 4, true) > bands[i]) return;
        const prox = 1 - Math.abs(node.y - v.camY) / (v.visibleHalf * 1.45);
        if (prox > bestProx) {
          bestProx = prox;
          pinned = i;
        }
      });
    }
    if (pinned >= 0) {
      next[pinned].preview = true;
      previewIdRef.current = next[pinned].id;
    } else {
      previewIdRef.current = null;
    }
    setItems((prev) => {
      if (
        prev.length === next.length &&
        prev.every(
          (p, i) =>
            p.id === next[i].id &&
            p.tier === next[i].tier &&
            p.preview === next[i].preview,
        )
      ) {
        return prev;
      }
      return next;
    });
  });

  const strandColorOf = useCallback(
    (node: TimelineNodeLayout): string =>
      node.strands.length > 0
        ? (layout.strands.find((s) => s.name === node.strands[0])?.color ??
          BRAND_OKLCH)
        : STRANDLESS_GREY,
    [layout],
  );

  return (
    <>
      {items.map(({ id, tier, preview }, idx) => {
        const node = layout.nodes.find((n) => n.id === id);
        if (!node) return null;
        const color = strandColorOf(node);
        // Strands first (strand-colored), then tags (neutral) — ALL of them,
        // naked square + text, wrapping freely; labels dedupe (the catalog
        // can carry the same word as both strand and tag). At L3+ the strand
        // chips become the arc-selection affordance (§R5.3).
        const seen = new Set<string>();
        const chips: {
          key: string;
          label: string;
          color: string;
          strand: string | null;
        }[] = [];
        for (const name of node.strands) {
          if (seen.has(name)) continue;
          seen.add(name);
          chips.push({
            key: `s:${name}`,
            label: name,
            color:
              layout.strands.find((s) => s.name === name)?.color ??
              BRAND_OKLCH,
            strand: name,
          });
        }
        for (const tag of node.tags) {
          if (seen.has(tag)) continue;
          seen.add(tag);
          chips.push({
            key: `t:${tag}`,
            label: tag,
            color: "var(--muted-foreground)",
            strand: null,
          });
        }
        const start = hhmm(node.start);
        const end = hhmm(node.end);
        const dimChips = selectedStrand !== null;
        return (
          <Html
            key={id}
            position={[node.position[0] + 1.35, node.position[1], 0]}
            zIndexRange={[25, 0]}
            style={{ pointerEvents: "none" }}
          >
            <div
              className="tl-card-in relative w-64 select-none overflow-hidden rounded-xl bg-card/85 px-3.5 pb-3 pt-2.5 ring-1 ring-foreground/10 backdrop-blur-xl"
              style={{ animationDelay: `${Math.min(idx, 5) * 45}ms` }}
            >
              {/* Accent hairline along the top edge — one accent per card
                  (site discipline: color as punctuation, never fills). */}
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
                style={{ backgroundColor: color, opacity: 0.55 }}
              />

              {/* Eyebrow: mono date · time range (tier ≥ 2). */}
              {tier >= 2 && (
                <p className="mb-1 flex items-center gap-1.5 font-mono text-[9px] leading-none tracking-[0.16em] text-muted-foreground">
                  <ColorSquare color={color} className="size-1.5" />
                  {node.date}
                  {start && (
                    <span>
                      &nbsp;· {start}
                      {end && ` – ${end}`}
                    </span>
                  )}
                </p>
              )}

              {/* Serif title (wraps at tier ≥ 2). */}
              <p
                className={`font-serif text-[14.5px] leading-snug tracking-tight text-card-foreground ${
                  tier === 1 ? "line-clamp-1" : ""
                }`}
              >
                {node.focus || node.date}
              </p>

              {/* Quiet label line: strand squares carry the only color, all
                  text stays muted mono; tags trail behind a middle dot. */}
              {chips.length > 0 && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] leading-tight">
                  {chips.map((c) => {
                    const selectable = c.strand !== null && tier >= 3;
                    const selected = c.strand !== null && c.strand === selectedStrand;
                    const cls = `inline-flex items-center gap-1 whitespace-nowrap transition-opacity ${
                      dimChips && !selected ? "opacity-40" : ""
                    } ${
                      selectable ? "pointer-events-auto cursor-pointer hover:opacity-80" : ""
                    }`;
                    const inner = c.strand !== null ? (
                      <>
                        <ColorSquare color={c.color} className="size-1" />
                        <span
                          className={
                            selected
                              ? "font-semibold text-foreground"
                              : "text-muted-foreground"
                          }
                        >
                          {c.label}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground/60">
                        · {c.label}
                      </span>
                    );
                    return selectable ? (
                      <button
                        key={c.key}
                        type="button"
                        className={cls}
                        onClick={() =>
                          onSelectStrand(selected ? null : c.strand)
                        }
                      >
                        {inner}
                      </button>
                    ) : (
                      <span key={c.key} className={cls}>
                        {inner}
                      </span>
                    );
                  })}
                </p>
              )}

              <Reveal show={tier >= 2 && !!node.summary}>
                <p className="mt-2 font-serif text-[12.5px] leading-relaxed text-foreground/80">
                  {node.summary}
                </p>
              </Reveal>

              <Reveal show={tier >= 3 && node.decisions.length > 0}>
                <div className="mt-2.5 border-t border-border/60 pt-2">
                  <p className="font-mono text-[9px] uppercase leading-none tracking-[0.2em] text-muted-foreground/80">
                    {t("card.decisions")}
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {node.decisions.map((d) => (
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
              </Reveal>
              <Reveal show={tier >= 3 && node.openLoops.length > 0}>
                <div className="mt-2.5 border-t border-border/60 pt-2">
                  <p className="font-mono text-[9px] uppercase leading-none tracking-[0.2em] text-muted-foreground/80">
                    {t("card.openLoops")}
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {node.openLoops.map((l) => (
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
              </Reveal>

              <Reveal show={tier >= 4}>
                <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 border-t border-border/60 pt-2 font-mono text-[9.5px] leading-normal tracking-[0.1em] tabular-nums text-muted-foreground/80">
                  {start && (
                    <span>
                      {start}
                      {end && ` – ${end}`}
                    </span>
                  )}
                  <span>· {t("card.turns", { count: node.turnCount })}</span>
                  {node.tone && <span>· {node.tone}</span>}
                  {node.continuesFrom && (
                    <span>· {t("card.continues")} ↳</span>
                  )}
                </p>
                {preview && (
                  <CardTurnsPreview
                    sliceId={id}
                    labels={{ user: t("turns.user"), agent: t("turns.agent") }}
                  />
                )}
              </Reveal>
            </div>
          </Html>
        );
      })}
    </>
  );
}

// ─── Strand arcs (§R5.3: semi-transparent curves through the carriers) ─────

// At L3+ each strand becomes a smooth CatmullRom curve through its carrier
// nodes, seated on its cable-bundle lane offset — the threads weave around
// and THROUGH the cards (the canvas sits under the translucent DOM cards, so
// a thread crossing a card reads as blurred depth). Default state is quiet
// (opacity ≈ 0.3); selecting a strand (chip click or line click) raises it
// to 0.9 and sinks the rest to 0.08, damped per frame.

interface StrandArcData {
  name: string;
  color: string;
  points: [number, number, number][];
}

function StrandArc({
  arc,
  selected,
  anySelected,
  onSelect,
}: {
  arc: StrandArcData;
  selected: boolean;
  anySelected: boolean;
  onSelect: (name: string | null) => void;
}) {
  // drei Line's ref is a Line2 (three-stdlib — a transitive dep we can't
  // import directly); grab just the material's opacity channel.
  const matRef = useRef<{ opacity: number } | null>(null);
  const points = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(
      arc.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    );
    return curve.getPoints(Math.max(24, arc.points.length * 12));
  }, [arc.points]);
  const target = anySelected ? (selected ? 0.9 : 0.08) : 0.3;
  useFrame((_, dt) => {
    const mat = matRef.current;
    if (mat) mat.opacity = THREE.MathUtils.damp(mat.opacity, target, 8, dt);
  });
  return (
    <DreiLine
      ref={(el) => {
        matRef.current = el
          ? (el as unknown as { material: { opacity: number } }).material
          : null;
      }}
      points={points}
      color={oklchToHex(arc.color)}
      lineWidth={selected ? 2 : 1.2}
      transparent
      opacity={0}
      toneMapped={false}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(selected ? null : arc.name);
      }}
      onPointerOver={() => {
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "auto";
      }}
    />
  );
}

function StrandArcs({
  layout,
  viewRef,
  selected,
  onSelect,
}: {
  layout: TimelineLayout;
  viewRef: React.MutableRefObject<ViewState>;
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const [arcs, setArcs] = useState<StrandArcData[]>([]);
  const lastProbe = useRef(0);
  const lastKey = useRef("");

  useFrame(() => {
    const now = performance.now();
    if (now - lastProbe.current < PROBE_MS) return;
    lastProbe.current = now;
    const v = viewRef.current;
    if (!v.zs.strandArcs) {
      if (lastKey.current !== "") {
        lastKey.current = "";
        setArcs([]);
      }
      return;
    }
    // Only the strands with ≥2 carriers in the camera window get a curve.
    // Window = larger of easing / target half-height (same anti-vanish
    // discipline as the node cards).
    const half =
      Math.max(
        v.visibleHalf,
        Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * v.zs.distance,
      ) * 1.6;
    const yLo = v.camY - half;
    const yHi = v.camY + half;
    const next: StrandArcData[] = [];
    for (const strand of layout.strands) {
      const pts: [number, number, number][] = [];
      for (const ni of strand.carriers) {
        const node = layout.nodes[ni];
        if (node.y < yLo || node.y > yHi) continue;
        pts.push([
          node.position[0] + strand.offset[0],
          node.y,
          strand.offset[1],
        ]);
      }
      if (pts.length >= 2) next.push({ name: strand.name, color: strand.color, points: pts });
    }
    const key = next
      .map(
        (a) =>
          `${a.name}:${a.points.length}:${a.points[0][1].toFixed(2)}:${a.points[a.points.length - 1][1].toFixed(2)}`,
      )
      .join("|");
    if (key !== lastKey.current) {
      lastKey.current = key;
      setArcs(next);
    }
  });

  return (
    <>
      {arcs.map((a) => (
        <StrandArc
          key={a.name}
          arc={a}
          selected={selected === a.name}
          anySelected={selected !== null}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// ─── Focused node: card + L3 turn strips ───────────────────────────────────

function FocusCard({
  node,
  layout,
  viewRef,
  content,
  contentState,
  onClose,
  onTraverse,
}: {
  node: TimelineNodeLayout;
  layout: TimelineLayout;
  viewRef: React.MutableRefObject<ViewState>;
  content: SliceContent | null;
  contentState: "loading" | "ready" | "failed";
  onClose: () => void;
  onTraverse: (sliceId: string) => void;
}) {
  const t = useTranslations("timeline3d");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showTurns, setShowTurns] = useState(false);
  const lastProbe = useRef(0);
  // One accent per card: the first strand's color (grey when strandless).
  const accent =
    node.strands.length > 0
      ? (layout.strands.find((s) => s.name === node.strands[0])?.color ??
        BRAND_OKLCH)
      : STRANDLESS_GREY;

  // L3 gating is a zoom function — probe the shared view state.
  useFrame(() => {
    const now = performance.now();
    if (now - lastProbe.current < PROBE_MS) return;
    lastProbe.current = now;
    const on = viewRef.current.zs.turns;
    setShowTurns((prev) => (prev === on ? prev : on));
  });

  useEffect(() => setExpanded(null), [node.id]);

  return (
    <Html
      position={[node.position[0] + 1.0, node.position[1], 0]}
      zIndexRange={[28, 0]}
    >
      <div className="tl-card-in relative w-72 overflow-hidden rounded-xl bg-popover/95 ring-1 ring-foreground/10 backdrop-blur-md">
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{ backgroundColor: accent, opacity: 0.55 }}
        />
        <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="mb-1 flex items-center gap-1.5 font-mono text-[9px] leading-none tracking-[0.16em] text-muted-foreground">
              <ColorSquare color={accent} className="size-1.5" />
              {node.date}
            </p>
            {node.focus && (
              <p className="line-clamp-2 font-serif text-[14px] leading-snug tracking-tight text-foreground">
                {node.focus}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t("turns.close")}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {node.summary && (
          <p className="line-clamp-4 px-3.5 py-2.5 font-serif text-[12px] leading-relaxed text-foreground/80">
            {node.summary}
          </p>
        )}

        {(node.strands.length > 0 || node.tags.length > 0) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 pb-2.5 font-mono text-[10px] leading-tight">
            {node.strands.map((name) => {
              const color =
                layout.strands.find((s) => s.name === name)?.color ??
                BRAND_OKLCH;
              return (
                <span
                  key={`s:${name}`}
                  className="inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <ColorSquare color={color} className="size-1" />
                  <span className="text-muted-foreground">{name}</span>
                </span>
              );
            })}
            {node.tags.map((tag) => (
              <span key={`t:${tag}`} className="text-muted-foreground/60">
                · {tag}
              </span>
            ))}
          </p>
        )}

        {/* L3: the slice's turn preview strip, user/agent colored. */}
        {showTurns && (
          <div
            data-tl-scroll
            className="max-h-56 overflow-y-auto border-t border-border"
          >
            {contentState === "loading" && (
              <div className="px-3.5 py-2.5" role="status">
                <span className="sr-only">{t("turns.loading")}</span>
                <TurnsSkeleton rows={4} />
              </div>
            )}
            {contentState === "failed" && (
              <p className="px-3.5 py-2.5 text-[11px] text-muted-foreground">
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
                    className={`block w-full px-3.5 py-1.5 text-left transition-colors ${
                      open ? "bg-accent" : "hover:bg-accent/60"
                    }`}
                  >
                    <span
                      className={`mr-1.5 font-mono text-[9px] uppercase tracking-[0.14em] ${
                        isUser
                          ? "font-semibold text-foreground/85"
                          : "text-muted-foreground"
                      }`}
                    >
                      {isUser ? t("turns.user") : t("turns.agent")}
                    </span>
                    <span
                      className={`text-[11px] leading-snug text-foreground/75 ${
                        open ? "whitespace-pre-wrap" : "line-clamp-1"
                      }`}
                    >
                      {open ? turn.content : firstLine(turn.content)}
                    </span>
                  </button>
                );
              })}
          </div>
        )}

        <div className="border-t border-border px-3.5 py-2.5">
          <button
            onClick={() => onTraverse(node.id)}
            className="w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-accent"
            style={{ color: BRAND_HEX }}
          >
            {t("turns.open")} →
          </button>
        </div>
      </div>
    </Html>
  );
}

// ─── NOW convergence point (§5.0: double ring, breathing, drop-shadow) ─────

function NowPoint({
  layout,
  onEnter,
  dark,
}: {
  layout: TimelineLayout;
  onEnter: () => void;
  dark: boolean;
}) {
  const t = useTranslations("timeline3d.now");
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
        position={layout.nowPosition}
        scale={[1.7, 1.7, 1]}
      />
      <Html position={layout.nowPosition} center zIndexRange={[26, 0]}>
        <button
          onClick={onEnter}
          className="group relative flex flex-col items-center outline-none"
          style={{
            filter: `drop-shadow(0 0 8px oklch(0.6 0.23 260 / 80%))`,
          }}
          aria-label={t("label")}
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
            {t("label")}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{t("sub")}</span>
        </button>
      </Html>
    </>
  );
}

// ─── The scene ─────────────────────────────────────────────────────────────

export default function SceneCanvas({
  layout,
  initialAtId,
}: SceneCanvasProps) {
  const t = useTranslations("timeline3d");
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
  // Strand selection (§R5.3) — shared by the card chips and the arc layer.
  const [strandSel, setStrandSel] = useState<string | null>(null);

  // Landing level (§R5.1): Index with cards visible; a deep link (?at=) opens
  // at Detail, centered on the linked node.
  const initial = useMemo(() => {
    let camY = layout.nowY + NOW_GAP + 1;
    let level: ZoomLevel = 1;
    if (initialAtId) {
      const node = layout.nodes.find((n) => n.id === initialAtId);
      if (node) {
        camY = node.y;
        level = 3;
      }
    }
    return { camY, level };
  }, [layout, initialAtId]);

  const viewRef = useRef<ViewState>({
    camY: initial.camY,
    level: initial.level,
    zs: zoomStateForLevel(initial.level),
    azimuth: 0,
    visibleHalf: 20,
  });
  const interactionRef = useRef<InteractionState>({ suppressClick: false });
  const dimmedRef = useRef(false);
  dimmedRef.current = focus.mode === "focus";

  const isTouch = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  const focusedSliceId = focus.mode === "focus" ? focus.sliceId : null;
  const focusedNode = useMemo(
    () => layout.nodes.find((n) => n.id === focusedSliceId) ?? null,
    [layout, focusedSliceId],
  );

  // L3 data: turn previews load only when a node is focused (§5.2).
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

  const startTraverse = useCallback(
    (sliceId: string) => setTraverseTo((cur) => cur ?? sliceId),
    [],
  );
  const enterNow = useCallback(() => setTraverseTo((cur) => cur ?? "now"), []);

  // Esc (capture): close the focus card, then the strand selection; consumed
  // presses must not reach the overlay's close-route listener on window.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (focus.mode === "focus") {
        e.stopPropagation();
        dispatch({ type: "EXIT" });
      } else if (strandSel !== null) {
        e.stopPropagation();
        setStrandSel(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focus, strandSel]);

  if (layout.nodes.length === 0) {
    return <TimelineFallback state="empty" />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <style>{TIMELINE_KEYFRAMES}</style>
      <AtmosphereBackdrop />

      <div className="absolute inset-0">
        <Canvas
          camera={{
            position: [0, initial.camY, LEVEL_DISTANCES[initial.level]],
            fov: FOV,
            near: 0.1,
            far: 500,
          }}
          gl={{ antialias: true, alpha: true }}
          dpr={[1, 2]}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          onPointerMissed={() => {
            if (interactionRef.current.suppressClick) return;
            // Clicking empty space clears the focus card, then the strand
            // selection. (Double-click on empty space: rotation self-resets
            // on release.)
            if (focus.mode === "focus") dispatch({ type: "EXIT" });
            else if (strandSel !== null) setStrandSel(null);
          }}
        >
          <CoreLine layout={layout} />
          <NodeSquares
            layout={layout}
            viewRef={viewRef}
            focusedId={focusedSliceId}
            onFocus={(sliceId) => dispatch({ type: "FOCUS", sliceId })}
            onTraverse={startTraverse}
            interactionRef={interactionRef}
          />
          <TimeLabels layout={layout} viewRef={viewRef} dimmedRef={dimmedRef} />
          <Beam layout={layout} dark={dark} />
          <Sparkles
            count={46}
            scale={[14, layout.yTop - layout.nowY + 12, 8]}
            position={[0, (layout.yTop + layout.nowY) / 2, 0]}
            size={1.6}
            speed={0.12}
            opacity={0.4}
            color={dark ? "#aebbdd" : "#8aa8dd"}
          />
          <NodeCards
            layout={layout}
            viewRef={viewRef}
            focusedId={focusedSliceId}
            selectedStrand={strandSel}
            onSelectStrand={setStrandSel}
          />
          <StrandArcs
            layout={layout}
            viewRef={viewRef}
            selected={strandSel}
            onSelect={setStrandSel}
          />
          {focusedNode && (
            <FocusCard
              node={focusedNode}
              layout={layout}
              viewRef={viewRef}
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
          <NowPoint layout={layout} onEnter={enterNow} dark={dark} />
          <CameraRig
            layout={layout}
            initialY={initial.camY}
            initialLevel={initial.level}
            viewRef={viewRef}
            interactionRef={interactionRef}
            focus={focus}
            onTraverse={startTraverse}
          />
          <EffectComposer>
            <Bloom
              intensity={0.6}
              luminanceThreshold={0.5}
              luminanceSmoothing={0.25}
              mipmapBlur
            />
          </EffectComposer>
        </Canvas>
      </div>

      <AtmosphereVignette />

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

      {/* Traverse crossfade (§5.2 L4 / NOW): fade to the chat background,
          then the route becomes `/?at=<sliceId>` (or `/` for NOW). */}
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
