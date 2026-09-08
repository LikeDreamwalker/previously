"use client";

/**
 * RowGroup (Rev 1) — one row of the 3D card field.
 *
 * Moved here from card-field.tsx so the main container can stay focused on
 * gesture/level/scroll orchestration. Each row renders:
 *   - the top card face (a real slice card, never a summary)
 *   - the pile's second real card in the first cascade slot (for L1/L2 stacks)
 *   - flat DOM backing sheets behind them to fake pile thickness.
 *
 * Content is loaded inside the card face via `SliceCardFace`; this file does
 * not know about the old `Map<string, ContentSlot>` data flow.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import {
  backingSheets,
  framePitchFor,
  poseScaleFor,
  sheetPose,
  type FrameGeometry,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import { settleEase } from "@/lib/timeline3d/pile-scene";
import { FrameCardTexts, frameCardLabel, SliceCardFace } from "./frame-card";
import type { FieldRig } from "./field-rig";

// ─── Tunables (mirrored from card-field.tsx) ─────────────────────────────────

const SHEET_GAP_PX = 5;
const DEAL_DURATION = 0.55;
const DEAL_STAGGER = 0.05;

declare global {
  interface Window {
    __dealDebug?: Array<{ rowKey: string; initialDeal: number; ts: number }>;
  }
}

function recordDealMount(rowKey: string, initialDeal: number) {
  if (typeof window === "undefined") return;
  window.__dealDebug ??= [];
  window.__dealDebug.push({ rowKey, initialDeal, ts: performance.now() });
}

function computeRowPosition(
  index: number,
  pitch: number,
  cardH: number,
  rig: FieldRig,
  viewportH: number,
  wpp: number,
  reducedMotion: boolean,
  anim: { deal: number; lift: number },
  rowKey: string,
): THREE.Vector3Tuple {
  const staggerOrder = Math.min(Math.abs(index - rig.anchorIndex), 12);
  const dealT = reducedMotion
    ? 1
    : settleEase(anim.deal - staggerOrder * (DEAL_STAGGER / DEAL_DURATION));

  const centerPy = index * pitch + cardH / 2 - rig.current;
  const yWorld = (viewportH / 2 - centerPy) * wpp;

  const origin = rig.dealOrigins?.get(rowKey);
  let x = 0;
  let y = yWorld;
  let z = 0;
  if (origin != null) {
    y = yWorld + (1 - dealT) * origin.dy;
    z = (1 - dealT) * origin.dz;
  } else {
    const dealOffsetY =
      (1 - dealT) * (rig.anchorIndex - index) * pitch * 0.35 * wpp;
    y = yWorld + dealOffsetY;
    z = (1 - dealT) * -0.45;
  }

  z += anim.lift * 0.05;
  return [x, y, z];
}

/** Sheet corner radius in px — identical to the face's rounded-[0.9em] where
 *  1em = cardW/26 (frame-card.tsx). Anything else breaks the illusion. */
export function sheetRadiusPx(geo: FrameGeometry): number {
  return (geo.cardW * 0.9) / 26;
}

export interface RowGroupProps {
  row: StackRow;
  index: number;
  geo: FrameGeometry;
  /** Row pitch (px) for this row's level. */
  pitch: number;
  rig: React.MutableRefObject<FieldRig>;
  reducedMotion: boolean;
  flash: boolean;
  dark: boolean;
  onActivate: (row: StackRow) => void;
  ariaLabel: string;
  texts: FrameCardTexts;
}

export function RowGroup({
  row,
  index,
  geo,
  pitch,
  rig,
  reducedMotion,
  flash,
  dark,
  onActivate,
  ariaLabel,
  texts,
}: RowGroupProps) {
  const groupRef = useRef<THREE.Group>(null);
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  // Deal starts at 0 only for rows in the transition's visible set.
  const animRef = useRef<{ deal: number; lift: number } | null>(null);
  if (animRef.current === null) {
    const initialDeal = reducedMotion
      ? 1
      : (rig.current.dealEligible?.has(row.key) ? 0 : 1);
    animRef.current = { deal: initialDeal, lift: 0 };
    recordDealMount(row.key, initialDeal);
  }

  const camDist = Math.hypot(camera.position.y, camera.position.z);
  const wpp =
    (2 * camDist * Math.tan(((camera.fov ?? 30) * Math.PI) / 360)) /
    size.height;
  // Cascade scale: authored against a 216px card, amplified for the big
  // frame (the pile must READ), but never let the deepest sheet's peek
  // overflow the row gap.
  const scale = useMemo(() => {
    const maxPeek = (pitch - geo.cardH) * 0.75;
    return Math.min(poseScaleFor(geo) * 1.6, maxPeek / 40);
  }, [geo, pitch]);
  // A pile's second layer is a REAL card too (its own slice, full content) —
  // it takes the first cascade slot, the shell sheets make up the rest.
  const second = row.level > 0 ? row.entries[1] : undefined;
  const sheets = Math.max(0, backingSheets(row.count) - (second ? 1 : 0));
  const poses = useMemo(
    () =>
      Array.from({ length: sheets + (second ? 1 : 0) }, (_, i) =>
        sheetPose(row.key, i),
      ),
    [row.key, sheets, second],
  );

  // Mount the group at the exact spot the first useFrame will compute so it
  // never flickers at the world origin before animation starts.
  const initialPos = useMemo<THREE.Vector3Tuple>(
    () =>
      computeRowPosition(
        index,
        pitch,
        geo.cardH,
        rig.current,
        size.height,
        wpp,
        reducedMotion,
        animRef.current!,
        row.key,
      ),
    [index, pitch, geo.cardH, rig, size.height, wpp, reducedMotion, row.key],
  );

  useFrame((_, rawDt) => {
    const group = groupRef.current;
    if (!group) return;
    const dt = Math.min(rawDt, 0.1);

    const anim = animRef.current!;
    anim.deal = Math.min(
      1 + (12 * DEAL_STAGGER) / DEAL_DURATION,
      anim.deal + dt / DEAL_DURATION,
    );
    if (
      rig.current.dealEligible &&
      anim.deal >= 1 + (12 * DEAL_STAGGER) / DEAL_DURATION
    ) {
      rig.current.dealEligible.delete(row.key);
    }
    const liftTarget = rig.current.hoverKey === row.key ? 1 : 0;
    anim.lift += (liftTarget - anim.lift) * Math.min(1, dt * 10);

    group.position.set(
      ...computeRowPosition(
        index,
        pitch,
        geo.cardH,
        rig.current,
        size.height,
        wpp,
        reducedMotion,
        anim,
        row.key,
      ),
    );

    // Sheets cascade behind the face; hover spreads the deck a little.
    const spread = 1 + anim.lift * 0.5;
    group.children.forEach((child, ci) => {
      if (ci === 0) return; // child 0 is the face anchor
      const si = ci - 1;
      const pose = poses[si];
      if (!pose) return;
      child.position.set(
        pose.offsetX * scale * spread * wpp,
        -pose.offsetY * scale * spread * wpp,
        -(si + 1) * SHEET_GAP_PX * spread * wpp,
      );
      child.rotation.set(
        -0.07 - si * 0.02,
        0,
        ((pose.rotate * 1.35) * Math.PI) / 180,
      );
    });
  });

  return (
    <group ref={groupRef} position={initialPos}>
      {/* Face anchor (child 0) — the Html portal hangs the DOM card here. */}
      <Html
        transform
        center
        distanceFactor={400 * wpp}
        zIndexRange={[30, 21]}
        style={{ pointerEvents: "auto" }}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          className="tl-card-in group cursor-pointer select-none"
          style={{ width: geo.cardW, height: geo.cardH }}
          onClick={() => onActivate(row)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onActivate(row);
            }
          }}
          onPointerEnter={() => (rig.current.hoverKey = row.key)}
          onPointerLeave={() => (rig.current.hoverKey = null)}
        >
          <SliceCardFace entry={row.top} geo={geo} flash={flash} texts={texts} />
        </div>
      </Html>
      {/* The pile's second card is REAL — its own slice's original card,
          same size/paper as the face, peeking from the first cascade slot. */}
      {second && (
        <Html
          transform
          center
          distanceFactor={400 * wpp}
          zIndexRange={[20, 11]}
          style={{ pointerEvents: "none" }}
        >
          <div aria-hidden style={{ width: geo.cardW, height: geo.cardH }}>
            <SliceCardFace entry={second} geo={geo} texts={texts} />
          </div>
        </Html>
      )}
      {/* Backing sheets: the SAME paper as the face (bg-card + ring), flat
          DOM cards — depth comes from each card's own CSS shadow, not from
          3D lighting. */}
      {poses.slice(second ? 1 : 0).map((_, si) => {
        // Absolute cascade layer (0 = directly behind the face) drives the
        // deep-layer fade.
        const li = si + (second ? 1 : 0);
        return (
          <Html
            key={`${row.key}#s${si}`}
            transform
            center
            distanceFactor={400 * wpp}
            zIndexRange={[10, 0]}
            style={{ pointerEvents: "none" }}
          >
            <div
              aria-hidden
              className={`bg-card ring-1 ring-foreground/10 ${
                dark
                  ? "shadow-[0_26px_60px_-14px_rgba(0,0,0,0.75)]"
                  : "shadow-[0_26px_60px_-14px_rgba(15,23,42,0.22)]"
              }`}
              style={{
                width: geo.cardW,
                height: geo.cardH,
                borderRadius: sheetRadiusPx(geo),
                opacity: li >= 4 ? Math.max(0.35, 1 - (li - 3) * 0.22) : 1,
              }}
            />
          </Html>
        );
      })}
    </group>
  );
}

