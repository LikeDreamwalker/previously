"use client";

/**
 * LeavingCard (Rev 1) — a slice that got swallowed by a coarser stack during
 * a level transition.
 *
 * Moved here from card-field.tsx. Like `RowGroup`, it renders a self-loading
 * `SliceCardFace` so content resolves independently instead of being driven by
 * a top-level `Map<string, ContentSlot>`.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { framePitchFor, type FrameGeometry, type StackRow } from "@/lib/timeline3d/stacks";
import { settleEase } from "@/lib/timeline3d/pile-scene";
import { FrameCardTexts, SliceCardFace } from "./frame-card";
import type { FieldRig, LeavingItem } from "./field-rig";

// ─── Tunables (mirrored from card-field.tsx) ─────────────────────────────────

const SHEET_GAP_PX = 5;
const DEAL_DURATION = 0.55;
const LEAVING_STAGGER_S = 0.03;

function computeLeavingPosition(
  item: LeavingItem,
  rows: StackRow[],
  pitch: number,
  cardH: number,
  rig: FieldRig,
  viewportH: number,
  wpp: number,
  reducedMotion: boolean,
  anim: { deal: number },
): THREE.Vector3Tuple {
  const dealT = reducedMotion
    ? 1
    : settleEase(anim.deal - item.depth * (LEAVING_STAGGER_S / DEAL_DURATION));

  const fromYWorld = (viewportH / 2 - item.fromYpx) * wpp;

  const targetIndex = rows.findIndex((r) => r.key === item.toRowKey);
  let targetYWorld = fromYWorld;
  if (targetIndex >= 0) {
    const centerPy = targetIndex * pitch + cardH / 2 - rig.current;
    targetYWorld = (viewportH / 2 - centerPy) * wpp;
  }

  const depthSign = item.depth % 2 === 0 ? 1 : -1;
  const depthJitterPx = 1 + (item.depth % 3);
  const targetYOffset = -item.depth * 1.5 * wpp;
  const targetXOffset = depthSign * depthJitterPx * wpp;

  const y = fromYWorld + dealT * (targetYWorld + targetYOffset - fromYWorld);
  const z = -(item.depth + 1) * SHEET_GAP_PX * wpp;

  return [targetXOffset, y, z];
}

export interface LeavingCardProps {
  item: LeavingItem;
  rows: StackRow[];
  geo: FrameGeometry;
  rig: React.MutableRefObject<FieldRig>;
  reducedMotion: boolean;
  texts: FrameCardTexts;
  onDone: (id: string) => void;
}

export function LeavingCard({
  item,
  rows,
  geo,
  rig,
  reducedMotion,
  texts,
  onDone,
}: LeavingCardProps) {
  const groupRef = useRef<THREE.Group>(null);
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const animRef = useRef<{ deal: number; done: boolean }>({
    deal: reducedMotion ? 1 : 0,
    done: reducedMotion,
  });

  const camDist = Math.hypot(camera.position.y, camera.position.z);
  const wpp =
    (2 * camDist * Math.tan(((camera.fov ?? 30) * Math.PI) / 360)) /
    size.height;
  const level = rows[0]?.level ?? 1;
  const pitch = framePitchFor(level, geo);

  // Mount the group at the exact spot the first useFrame will compute so it
  // never flickers at the world origin before animation starts.
  const initialPos = useMemo<THREE.Vector3Tuple>(
    () =>
      computeLeavingPosition(
        item,
        rows,
        pitch,
        geo.cardH,
        rig.current,
        size.height,
        wpp,
        reducedMotion,
        animRef.current,
      ),
    [
      item,
      rows,
      pitch,
      geo.cardH,
      rig,
      size.height,
      wpp,
      reducedMotion,
    ],
  );

  useFrame((_, rawDt) => {
    const group = groupRef.current;
    if (!group) return;
    const dt = Math.min(rawDt, 0.1);

    const anim = animRef.current;
    anim.deal = Math.min(
      1 + (12 * LEAVING_STAGGER_S) / DEAL_DURATION,
      anim.deal + dt / DEAL_DURATION,
    );
    const dealT = reducedMotion
      ? 1
      : settleEase(
          anim.deal - item.depth * (LEAVING_STAGGER_S / DEAL_DURATION),
        );

    group.position.set(
      ...computeLeavingPosition(
        item,
        rows,
        pitch,
        geo.cardH,
        rig.current,
        size.height,
        wpp,
        reducedMotion,
        anim,
      ),
    );

    if (dealT >= 1 && !anim.done) {
      anim.done = true;
      onDone(item.id);
    }
  });

  return (
    <group ref={groupRef} position={initialPos}>
      <Html
        transform
        center
        distanceFactor={400 * wpp}
        zIndexRange={[25, 16]}
        style={{ pointerEvents: "none" }}
      >
        <div aria-hidden style={{ width: geo.cardW, height: geo.cardH }}>
          <SliceCardFace entry={item.slice} geo={geo} texts={texts} />
        </div>
      </Html>
    </group>
  );
}
