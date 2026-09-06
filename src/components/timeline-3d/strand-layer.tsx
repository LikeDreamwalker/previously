"use client";

/**
 * Strand layer (Rev 7 §R7.2, Manhattan revision 2026-09-07): the multi-
 * timeline fiber bundle. Colored strand lines share ONE vertical at BUNDLE_X
 * left of the spine (collinear, over a semi-transparent tinted band whose
 * density reads as "how many strands are alive"), depart horizontally into
 * the visible regions' serpentine grids (through related cards on the row
 * midline, around unrelated ones on the gap midline), and converge into the
 * NOW point. Lines keep a fixed small parallel y offset and never merge.
 *
 * All geometry is pure (`computeStrandGeometry` in lib/timeline3d/strand-scene)
 * and rebuilt only at the window-probe cadence (§R7.4). The zoom-flight
 * freeze mirrors RegionLayer: strands are WebGL (no drei-Html starvation),
 * but keeping the previous level's geometry mid-flight reads as visual
 * continuity next to the frozen cards. No strand interaction this version
 * (§R7.6) — every mesh opts out of raycast.
 *
 * Animation: one or two bright flow dots drift along each visible strand
 * (方向感向导 — the serpentine runs right→left on odd rows, the eye needs the
 * motion cue). Dots ride the strand's sampled track by arclength; progress is
 * keyed by strand name so a geometry rebuild doesn't reset them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Line as DreiLine } from "@react-three/drei";
import { useTheme } from "@teispace/next-themes";
import {
  BUNDLE_X,
  computeStrandGeometry,
  trackPointAt,
  type StrandSceneGeometry,
  type StrandTrack,
  type Vec3,
} from "@/lib/timeline3d/strand-scene";
import type { RegionScene } from "@/lib/timeline3d/regions";
import type { ViewState } from "./scene-canvas";

/** Probe cadence — mirrors PROBE_MS in scene-canvas (window layers share it). */
const PROBE_MS = 200;
/** Window overscan factor — mirrors RegionLayer's winHalf × 1.6. */
const WIN_OVERSCAN = 1.6;

/** Flow-dot drift speed, world units per second. */
const DOT_SPEED = 1.2;
const DOT_RADIUS = 0.055;
/** Tracks longer than this carry two dots (half a track apart). */
const DOT_TWO_THRESHOLD = 26;

/**
 * The tinted bundle band behind the collinear verticals: a plane with a
 * canvas-painted HORIZONTAL alpha gradient (peak at the left edge, fading to
 * 0 at the right edge — the lines dissolve into the band toward the window
 * edge). Texture rebuilds only on theme change; geometry follows the band
 * span from the probe.
 */
function BundleBand({
  geom,
  dark,
}: {
  geom: StrandSceneGeometry;
  dark: boolean;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    const rgb = dark ? "120,140,190" : "90,110,160";
    grad.addColorStop(0, `rgba(${rgb},${dark ? 0.18 : 0.13})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  }, [dark]);
  useEffect(() => () => texture.dispose(), [texture]);

  const { yLo, yHi } = geom.band;
  if (yHi - yLo <= 0) return null;
  return (
    <mesh
      position={[BUNDLE_X - 0.5, (yLo + yHi) / 2, -0.8]}
      raycast={() => null}
      frustumCulled={false}
    >
      <planeGeometry args={[1.6, yHi - yLo]} />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

function StrandDots({ geom }: { geom: StrandSceneGeometry }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  /** Per-strand dot progress fractions (0..1) — survive geometry rebuilds. */
  const fracsRef = useRef(new Map<string, number[]>());

  const dots = useMemo(() => {
    const list: { track: StrandTrack; dotIdx: number }[] = [];
    for (const track of geom.tracks) {
      const count = track.total > DOT_TWO_THRESHOLD ? 2 : 1;
      const prev = fracsRef.current.get(track.name) ?? [];
      const next: number[] = [];
      for (let i = 0; i < count; i++) next.push(prev[i] ?? i / count);
      fracsRef.current.set(track.name, next);
      for (let i = 0; i < count; i++) list.push({ track, dotIdx: i });
    }
    return list;
  }, [geom]);

  const { geometry, material } = useMemo(
    () => ({
      geometry: new THREE.SphereGeometry(DOT_RADIUS, 10, 10),
      material: new THREE.MeshBasicMaterial({
        toneMapped: false,
        transparent: true,
        opacity: 0.95,
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

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const c = new THREE.Color();
    dots.forEach((d, i) => mesh.setColorAt(i, c.set(d.track.color)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [dots]);

  const tmpM = useRef(new THREE.Matrix4());
  const tmpP = useRef<Vec3>([0, 0, 0]);
  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = tmpM.current;
    const p = tmpP.current;
    dots.forEach((d, i) => {
      const fracs = fracsRef.current.get(d.track.name);
      if (!fracs) return;
      fracs[d.dotIdx] =
        (fracs[d.dotIdx] + (delta * DOT_SPEED) / d.track.total) % 1;
      trackPointAt(d.track, fracs[d.dotIdx] * d.track.total, p);
      m.identity();
      m.setPosition(p[0], p[1], p[2]);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (dots.length === 0) return null;
  return (
    <instancedMesh
      key={dots.length}
      ref={meshRef}
      args={[geometry, material, dots.length]}
      raycast={() => null}
      frustumCulled={false}
    />
  );
}

export function StrandLayer({
  scene,
  viewRef,
}: {
  scene: RegionScene;
  viewRef: React.MutableRefObject<ViewState>;
}) {
  const [geom, setGeom] = useState<StrandSceneGeometry | null>(null);
  const geomRef = useRef<StrandSceneGeometry | null>(null);
  const lastProbe = useRef(0);
  const lastSig = useRef("");
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  useFrame(() => {
    const now = performance.now();
    if (now - lastProbe.current < PROBE_MS) return;
    lastProbe.current = now;
    const v = viewRef.current;
    const winHalf = v.visibleHalf * WIN_OVERSCAN;
    const next = computeStrandGeometry(
      scene,
      v.camY - winHalf,
      v.camY + winHalf,
    );
    if (next.signature === lastSig.current) return;
    if (v.levelFlight && geomRef.current) return; // zoom-flight freeze
    lastSig.current = next.signature;
    geomRef.current = next;
    setGeom(next);
  });

  if (!geom || geom.lines.length === 0) return null;
  return (
    <group>
      <BundleBand geom={geom} dark={dark} />
      {geom.lines.map((l) => (
        <DreiLine
          key={l.key}
          points={l.points}
          color={l.color}
          lineWidth={l.width}
          transparent
          opacity={l.opacity}
          toneMapped={false}
          depthWrite={false}
          raycast={() => null}
        />
      ))}
      <StrandDots geom={geom} />
    </group>
  );
}
