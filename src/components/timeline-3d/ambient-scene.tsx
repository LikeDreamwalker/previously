"use client";

/**
 * AmbientScene (Rev 13, "the Ruler") — the timeline's LEFT band: a dense,
 * uniform, engraved ruler. Fixed-spacing year/month ticks run from NOW upward,
 * extending past the data window when necessary so the ruler always reads as a
 * ruler. A 1px spine carries a sketched cylinder hatch on its left; strand
 * filaments sit further left. No bloom, no glow. Pointer-transparent; loaded
 * via next/dynamic ssr:false.
 */
import { useEffect, useRef } from "react";
import { useTheme } from "@teispace/next-themes";
import { hashString, oklchToHex, strandColor } from "@/lib/timeline3d/layout";

export interface AmbientSceneProps {
  /** Strand names (display order = fiber order), capped by the caller. */
  strands: string[];
  /** The filter's selection — null = 核心时间线 (everything even). */
  selected: string | null;
  /** Card-field scroll progress 0..1 (0 = oldest/top, 1 = now/bottom).
   *  Written by the card field every frame; read here without re-renders. */
  progressRef: React.MutableRefObject<number>;
  /** Visible date range of the catalog. `oldest` is the earliest loaded
   *  slice's `date`; `now` is the current calendar date. */
  range: { oldest: string; now: string };
}

const CORE_HEX = "#0066FF";
const YEAR_TICK_WIDTH = 24;
const MONTH_TICK_WIDTH = 11;
const LABEL_SIZE = 9;
const NOW_RADIUS = 3;
const TARGET_MONTH_PX = 105;
const TARGET_YEAR_PX = 100;

/** Parse a "YYYY-MM-DD" date into a local midnight Date. */
function parseDate(date: string): Date | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const out = new Date(y, mo, d);
  if (
    Number.isNaN(out.getTime()) ||
    out.getFullYear() !== y ||
    out.getMonth() !== mo ||
    out.getDate() !== d
  ) {
    return null;
  }
  return out;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function monthBoundary(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, 1);
}

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/** Cylinder hatch on the immediate left of the spine: short vertical strokes
 *  whose opacity falls off from the spine outward, suggesting a rounded rod. */
function drawCylinderHatch(
  ctx: CanvasRenderingContext2D,
  height: number,
  left: number,
  right: number,
  ink: string,
  baseAlpha: number,
) {
  const width = right - left;
  if (width <= 2) return;

  const cols = Math.max(3, Math.floor(width / 2));
  const colStep = width / cols;

  ctx.lineWidth = 1;
  for (let i = 0; i < cols; i++) {
    const x = left + (i + 0.5) * colStep;
    const t = (x - left) / width; // 0 at outer edge, 1 at spine
    const alpha = baseAlpha * (0.1 + 0.9 * t * t);
    const segLen = 6 + 24 * t * t;
    const gap = 8 - 3 * t * t;

    ctx.strokeStyle = `rgba(${ink},${alpha})`;
    const xPx = Math.round(x) + 0.5;
    let y = (i * 7) % Math.max(1, Math.floor(segLen + gap));

    while (y < height) {
      const len = Math.min(segLen, height - y);
      ctx.beginPath();
      ctx.moveTo(xPx, y);
      ctx.lineTo(xPx, y + len);
      ctx.stroke();
      y += len + gap;
    }
  }
}

function drawStrands(
  ctx: CanvasRenderingContext2D,
  height: number,
  rightBound: number,
  strands: string[],
  selected: string | null,
  dark: boolean,
) {
  const n = strands.length;
  if (n === 0 || rightBound <= 4) return;

  const leftMargin = 2;
  const available = Math.max(0, rightBound - leftMargin);
  const step = available / Math.max(n, 1);

  for (let i = 0; i < n; i++) {
    const name = strands[i];
    const h = hashString(`strand-x:${name}`);
    const jitter = ((h % 1000) / 1000 - 0.5) * step * 0.3;
    const x = leftMargin + step * (i + 0.5) + jitter;
    if (x < leftMargin || x > rightBound - 1) continue;

    const hex = oklchToHex(strandColor(name));
    const isSelected = selected === name;
    const dimmed = selected !== null && !isSelected;
    const alpha = isSelected
      ? dark
        ? 0.45
        : 0.4
      : dimmed
        ? 0.07
        : dark
          ? 0.18
          : 0.15;

    ctx.beginPath();
    ctx.strokeStyle = hexToRgba(hex, alpha);
    ctx.lineWidth = 1;
    const xPx = Math.round(x) + 0.5;
    ctx.moveTo(xPx, 0);
    ctx.lineTo(xPx, height);
    ctx.stroke();
  }
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dark: boolean,
  strands: string[],
  selected: string | null,
  progress: number,
  range: { oldest: string; now: string },
) {
  ctx.clearRect(0, 0, width, height);

  const oldest = parseDate(range.oldest);
  const now = parseDate(range.now);

  // Layout zones, left to right: strands → cylinder hatch → spine → ticks/labels.
  const axisX = width >= 140 ? width * 0.58 : width * 0.5;
  const axisXPx = Math.round(axisX) + 0.5;
  const strandRight = Math.max(2, axisX - 18);
  const hatchLeft = Math.max(strandRight + 1, axisX - 14);
  const hatchRight = axisX;
  const showLabels = width >= 140;
  const yearTickW = Math.min(
    YEAR_TICK_WIDTH,
    Math.max(8, width - axisX - 4),
  );
  const monthTickW = Math.min(
    MONTH_TICK_WIDTH,
    Math.max(5, width - axisX - 6),
  );
  const labelX = axisXPx + yearTickW + 5;

  const ink = dark ? "229,231,235" : "31,41,55";
  const tickAlpha = dark ? 0.7 : 0.65;
  const spineAlpha = dark ? 0.8 : 0.75;

  drawStrands(ctx, height, strandRight, strands, selected, dark);
  drawCylinderHatch(ctx, height, hatchLeft, hatchRight, ink, dark ? 0.55 : 0.5);

  // Spine.
  ctx.beginPath();
  ctx.strokeStyle = `rgba(${ink},${spineAlpha})`;
  ctx.lineWidth = 1;
  ctx.moveTo(axisXPx, 0);
  ctx.lineTo(axisXPx, height);
  ctx.stroke();

  if (!oldest || !now || now.getTime() <= oldest.getTime()) {
    ctx.beginPath();
    ctx.fillStyle = CORE_HEX;
    ctx.arc(axisXPx, height - 10, NOW_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Sparse (> ~3.5 years) shows only year ticks; otherwise year + month.
  const sparse =
    now.getTime() - oldest.getTime() >
    1000 * 60 * 60 * 24 * 365.25 * 3.5;

  let stripHeight: number;
  let tickCount: number;
  let drawTicks: (i: number, canvasY: number) => void;

  ctx.textBaseline = "middle";
  ctx.font = `400 ${LABEL_SIZE}px ui-monospace, SFMono-Regular, Menlo, monospace`;

  if (sparse) {
    const endYear = now.getFullYear();
    const dataStartYear = oldest.getFullYear();
    const dataYears = Math.max(1, endYear - dataStartYear + 1);
    const requiredYears = Math.ceil((height * 2) / TARGET_YEAR_PX);
    const unitCount = Math.max(dataYears - 1, requiredYears);
    stripHeight = unitCount * TARGET_YEAR_PX;
    tickCount = unitCount + 1;

    drawTicks = (i, canvasY) => {
      const year = endYear - i;
      const yPx = Math.round(canvasY) + 0.5;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${ink},${tickAlpha})`;
      ctx.lineWidth = 1;
      ctx.moveTo(axisXPx, yPx);
      ctx.lineTo(axisXPx + yearTickW, yPx);
      ctx.stroke();

      if (showLabels) {
        ctx.fillStyle = `rgba(${ink},${dark ? 0.85 : 0.8})`;
        ctx.fillText(String(year), labelX, canvasY + 0.5);
      }
    };
  } else {
    const endMonth = monthBoundary(now);
    const dataStartMonth = monthBoundary(oldest);
    const dataMonths = Math.max(1, monthsBetween(dataStartMonth, endMonth));
    const requiredMonths = Math.ceil((height * 2) / TARGET_MONTH_PX);
    const unitCount = Math.max(dataMonths, requiredMonths);
    stripHeight = unitCount * TARGET_MONTH_PX;
    tickCount = unitCount + 1;

    drawTicks = (i, canvasY) => {
      const d = addMonths(endMonth, -i);
      const isYear = d.getMonth() === 0;
      const tickW = isYear ? yearTickW : monthTickW;
      const alpha = isYear ? tickAlpha + 0.08 : tickAlpha - 0.05;
      const yPx = Math.round(canvasY) + 0.5;

      ctx.beginPath();
      ctx.strokeStyle = `rgba(${ink},${alpha})`;
      ctx.lineWidth = 1;
      ctx.moveTo(axisXPx, yPx);
      ctx.lineTo(axisXPx + tickW, yPx);
      ctx.stroke();

      if (isYear && showLabels) {
        ctx.fillStyle = `rgba(${ink},${dark ? 0.85 : 0.8})`;
        ctx.fillText(String(d.getFullYear()), labelX, canvasY + 0.5);
      }
    };
  }

  const offsetY = progress * Math.max(0, stripHeight - height);

  for (let i = 0; i < tickCount; i++) {
    const yOnStrip = stripHeight - i * (sparse ? TARGET_YEAR_PX : TARGET_MONTH_PX);
    const canvasY = yOnStrip - offsetY;
    const pad = sparse ? 18 : 10;
    if (canvasY < -pad || canvasY > height + pad) continue;
    drawTicks(i, canvasY);
  }

  // NOW dot — fixed at the bottom of the band.
  ctx.beginPath();
  ctx.fillStyle = CORE_HEX;
  ctx.arc(axisXPx, height - 10, NOW_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

export default function AmbientScene({
  strands,
  selected,
  progressRef,
  range,
}: AmbientSceneProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  const argsRef = useRef({
    dark,
    strands,
    selected,
    range,
  });
  argsRef.current = { dark, strands, selected, range };

  const lastDrawnRef = useRef<{
    width: number;
    height: number;
    dark: boolean;
    strands: string[];
    selected: string | null;
    progress: number;
    range: { oldest: string; now: string };
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        2,
      );
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width, height, dpr };
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const { width, height } = sizeRef.current;
      if (width === 0 || height === 0) return;
      const { dark: d, strands: s, selected: sel, range: r } = argsRef.current;
      const progress = progressRef.current;
      const last = lastDrawnRef.current;
      if (
        last &&
        last.width === width &&
        last.height === height &&
        last.dark === d &&
        last.strands === s &&
        last.selected === sel &&
        last.progress === progress &&
        last.range === r
      ) {
        return;
      }
      lastDrawnRef.current = { width, height, dark: d, strands: s, selected: sel, progress, range: r };
      drawRuler(ctx, width, height, d, s, sel, progress, r);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // refs are stable; drawing inputs are read from argsRef each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
