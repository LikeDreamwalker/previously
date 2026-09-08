"use client";

/**
 * PileField (Rev 9 §R9.2) — the 3D base under the stack list: ONE
 * transparent R3F canvas absolute-positioned under the DOM list (z-0,
 * pointer-transparent), rendering each visible stack's pile as a small deck
 * of thin rounded sheets.
 *
 * Why not drei View: the list is virtualized — per-row Views would mount and
 * unmount scissor viewports constantly. Because cards and rows are
 * fixed-size (stacks.ts), every pile's screen rect is a pure function of
 * (rowIndex, scrollTop); we unproject the card center into the z=0 plane per
 * pile per frame — no DOM measurement, no React re-render on scroll.
 *
 * Motion: scroll-velocity rocking (the deck wobbles like real cards when the
 * table shakes), hover lift + sheet spread (the row's DOM pointer events set
 * `hoverKeyRef`), and a staggered deal-in for newly-seen piles (level/filter
 * changes). All per-frame state lives in refs — React only re-renders when
 * the pile SET changes.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import {
  DEAL_DURATION,
  DEAL_STAGGER,
  PILE_CAM_Y,
  PILE_CAM_Z,
  PILE_FOV_DEG,
  ROCK_MAX,
  SHEET_GAP,
  SHEET_THICK,
  SHEET_TILT_STEP,
  SHEET_TILT_X,
  settleEase,
  worldPerPx,
  type PileSpec,
} from "@/lib/timeline3d/pile-scene";
import { sheetPose, type CardGeometry } from "@/lib/timeline3d/stacks";
import { hashString } from "@/lib/timeline3d/layout";

export interface PileFieldProps {
  specs: PileSpec[];
  geo: CardGeometry;
  /** Row pitch px for the current level. */
  pitch: number;
  /** The list scroller element — the pile field reads scrollTop per frame. */
  scrollerElRef: React.MutableRefObject<HTMLElement | null>;
  /** Hovered stack row key (DOM pointer events on the row). */
  hoverKeyRef: React.MutableRefObject<string | null>;
  dark: boolean;
  reducedMotion: boolean;
}

interface SheetSlot {
  spec: PileSpec;
  /** Sheet index within the pile (0 = shallowest rendered). */
  sheet: number;
}

/** Frames with no scroll/animation above this delta are cheap anyway; the
 *  scene is tiny, so we just render every frame. */
function PileScene({
  specs,
  geo,
  pitch,
  scrollerElRef,
  hoverKeyRef,
  dark,
  reducedMotion,
}: PileFieldProps) {
  const { camera, size } = useThree();
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  // Flatten specs → sheet slots. React re-renders only when the set changes.
  const slots = useMemo<SheetSlot[]>(
    () =>
      specs.flatMap((spec) =>
        Array.from({ length: spec.sheets }, (_, i) => ({ spec, sheet: i })),
      ),
    [specs],
  );

  // Card face size in world units.
  const wppMemo = useMemo(() => worldPerPx(size.height), [size.height]);
  const sheetW = geo.cardW * wppMemo;
  const sheetH = geo.cardH * wppMemo;

  // Paper tones per depth, per theme (deeper = slightly darker).
  // Paper tones per depth, per theme. The sheet rims must READ against the
  // DOM card above them: card is oklch(0.205) dark / pure white light, so the
  // sheets sit a clear step AWAY from it (lighter warm-gray dark, warm paper
  // light) and step darker with depth (occlusion).
  const sheetColors = useMemo(() => {
    const base = new THREE.Color(dark ? "#454b58" : "#f2ede2");
    return [0, 1, 2].map((d) => {
      const c = base.clone();
      if (dark) c.offsetHSL(0, 0, -0.05 * d);
      else c.offsetHSL(0, 0.015, -0.05 * d);
      return `#${c.getHexString()}`;
    });
  }, [dark]);

  // Per-pile animation state: deal settle + hover lift, keyed by pile key.
  const animRef = useRef(new Map<string, { deal: number; lift: number }>());
  useEffect(() => {
    const map = animRef.current;
    const alive = new Set(specs.map((s) => s.key));
    for (const key of [...map.keys()]) if (!alive.has(key)) map.delete(key);
    specs.forEach((s) => {
      if (!map.has(s.key)) map.set(s.key, { deal: 0, lift: 0 });
    });
  }, [specs]);

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const planeZ0 = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    [],
  );
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const hit = useMemo(() => new THREE.Vector3(), []);
  const lastScrollRef = useRef<number | null>(null);
  const velRef = useRef(0);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const wpp = worldPerPx(size.height);
    const scrollTop = scrollerElRef.current?.scrollTop ?? 0;

    // Smoothed scroll velocity (px/s → rocking).
    const last = lastScrollRef.current;
    const inst = last == null || dt <= 0 ? 0 : (scrollTop - last) / dt;
    lastScrollRef.current = scrollTop;
    velRef.current += (inst - velRef.current) * Math.min(1, dt * 8);
    const rockBase = reducedMotion
      ? 0
      : THREE.MathUtils.clamp(velRef.current * 0.00004, -ROCK_MAX, ROCK_MAX);

    const hoverKey = hoverKeyRef.current;

    slots.forEach((slot, si) => {
      const mesh = meshRefs.current[si];
      if (!mesh) return;
      const { spec, sheet } = slot;
      const anim = animRef.current.get(spec.key);

      // Screen position of the row's card center (pure function — §R9.1).
      const centerPy = spec.rowIndex * pitch + geo.cardH / 2 - scrollTop;
      const margin = geo.cardH + 120;
      if (centerPy < -margin || centerPy > size.height + margin) {
        mesh.visible = false;
        return;
      }

      // Card center → world point on the z=0 plane.
      ndc.set(0, -((centerPy / size.height) * 2 - 1));
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(planeZ0, hit)) {
        mesh.visible = false;
        return;
      }

      // Deal-in + hover lift.
      if (anim) {
        anim.deal = Math.min(1, anim.deal + dt / DEAL_DURATION);
        const liftTarget = hoverKey === spec.key ? 1 : 0;
        anim.lift += (liftTarget - anim.lift) * Math.min(1, dt * 10);
      }
      // Stagger the deal outward from the viewport's center row.
      const centerRow = Math.floor((scrollTop + size.height / 2) / pitch);
      const staggerOrder = Math.min(Math.abs(spec.rowIndex - centerRow), 10);
      const dealT = reducedMotion
        ? 1
        : settleEase(
            (anim?.deal ?? 1) - staggerOrder * (DEAL_STAGGER / DEAL_DURATION),
          );
      const lift = reducedMotion ? 0 : (anim?.lift ?? 0);

      const pose = sheetPose(spec.key, sheet);
      const rockSign = hashString(spec.key) & 1 ? 1 : -1;
      const gap = SHEET_GAP * (1 + lift * 0.6);

      mesh.visible = true;
      mesh.position.set(
        hit.x + pose.offsetX * wpp,
        hit.y - pose.offsetY * wpp - (1 - dealT) * 0.35,
        hit.z - (sheet + 1) * gap + (1 - dealT) * 0.3 + lift * 0.05,
      );
      mesh.rotation.set(
        SHEET_TILT_X + sheet * SHEET_TILT_STEP,
        0,
        (pose.rotate * Math.PI) / 180 +
          rockBase * rockSign * dealT +
          (1 - dealT) * pose.rotate * 0.04,
      );
    });
  });

  return (
    <>
      <hemisphereLight args={[dark ? "#3a4152" : "#ffffff", dark ? "#101216" : "#b8b0a0", dark ? 1.25 : 0.9]} />
      <directionalLight position={[2.5, 4, 6]} intensity={dark ? 1.9 : 1.1} color={dark ? "#e4eaff" : "#fff2df"} />
      {slots.map((slot, si) => (
        <RoundedBox
          key={`${slot.spec.key}#${slot.sheet}`}
          ref={(m: THREE.Mesh | null) => {
            meshRefs.current[si] = m;
          }}
          args={[sheetW, sheetH, SHEET_THICK]}
          radius={0.012}
          smoothness={2}
          raycast={() => null}
        >
          <meshStandardMaterial
            color={sheetColors[slot.sheet]}
            roughness={0.92}
          />
        </RoundedBox>
      ))}
    </>
  );
}

export default function PileField(props: PileFieldProps) {
  return (
    <Canvas
      // Under the DOM list; purely visual, never interactive.
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      dpr={[1, 1.75]}
      camera={{
        position: [0, PILE_CAM_Y, PILE_CAM_Z],
        fov: PILE_FOV_DEG,
      }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
    >
      <PileScene {...props} />
    </Canvas>
  );
}
