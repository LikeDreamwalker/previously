"use client";

/**
 * TimelineScene — the shared client component behind both forms of the
 * /timeline route (full page and intercepted overlay). Loads the R3F scene
 * via next/dynamic with ssr:false (three.js never enters the server render
 * or the cloud first-load bundle), gates on WebGL availability, and renders
 * the fallback when the scene can't run (the TimelineWheel precise view).
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { TimelineLayout } from "@/lib/timeline3d/layout";
import { TimelineFallback } from "./timeline-fallback";

const SceneCanvas = dynamic(() => import("./scene-canvas"), {
  ssr: false,
  loading: () => <TimelineFallback state="loading" />,
});

export interface TimelineSceneProps {
  layout: TimelineLayout;
  /** Slice id from `?at=` — initial camera position. */
  initialAtId?: string;
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ?? canvas.getContext("webgl"),
    );
  } catch {
    return false;
  }
}

export function TimelineScene(props: TimelineSceneProps) {
  // null = not yet checked (first client render matches the server shell).
  const [webgl, setWebgl] = useState<boolean | null>(null);
  useEffect(() => {
    setWebgl(detectWebGL());
  }, []);

  if (webgl === null) return <TimelineFallback state="loading" />;
  if (!webgl) return <TimelineFallback state="unsupported" />;
  return <SceneCanvas {...props} />;
}
