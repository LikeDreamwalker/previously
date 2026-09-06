"use client";

/**
 * TimelineScene — the shared client component behind both forms of the
 * /timeline route (full page and intercepted overlay). Loads the R3F scene
 * via next/dynamic with ssr:false (three.js never enters the server render
 * or the cloud first-load bundle), gates on WebGL availability, and renders
 * the fallback when the scene can't run (the TimelineWheel precise view).
 *
 * Owns the catalog window (Rev 7 §R7.4): starts from the server's latest
 * months and prepends older windows when the camera nears the top —
 * `onNeedOlder` fires from the scene, the prepend re-anchors the camera on
 * the same slice so the world never jumps.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { getTimelineCatalogPage } from "@/lib/episodic/actions";
import { TimelineFallback } from "./timeline-fallback";

const SceneCanvas = dynamic(() => import("./scene-canvas"), {
  ssr: false,
  loading: () => <TimelineFallback state="loading" />,
});

export interface TimelineSceneProps {
  /** The initial catalog window (oldest → newest), the latest months. */
  initialEntries: TimelineSliceEntry[];
  /** Month key (YYYY-MM) of the oldest loaded entry — the next page's
   *  `before` cursor. */
  initialOldestMonth: string | null;
  /** Whether entries older than the initial window exist. */
  initialHasMore: boolean;
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

export function TimelineScene({
  initialEntries,
  initialOldestMonth,
  initialHasMore,
  initialAtId,
}: TimelineSceneProps) {
  // null = not yet checked (first client render matches the server shell).
  const [webgl, setWebgl] = useState<boolean | null>(null);
  useEffect(() => {
    setWebgl(detectWebGL());
  }, []);

  const [entries, setEntries] = useState(initialEntries);
  const [oldestMonth, setOldestMonth] = useState(initialOldestMonth);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const loadingRef = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingRef.current || !oldestMonth) return;
    loadingRef.current = true;
    try {
      const page = await getTimelineCatalogPage(oldestMonth);
      if (page.entries.length === 0) {
        setHasMore(false);
        return;
      }
      // Dedupe defensively: a month already present means we raced a
      // previous prepend — merge by id instead of duplicating cards.
      setEntries((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const older = page.entries.filter((e) => !have.has(e.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
      setOldestMonth(page.oldestMonth);
      setHasMore(page.hasMore);
    } catch {
      // A failed prefetch is silent: the camera just finds no older cards
      // and the next edge approach retries.
    } finally {
      loadingRef.current = false;
    }
  }, [hasMore, oldestMonth]);

  if (webgl === null) return <TimelineFallback state="loading" />;
  if (!webgl) return <TimelineFallback state="unsupported" />;
  return (
    <SceneCanvas
      entries={entries}
      hasMore={hasMore}
      onNeedOlder={loadOlder}
      initialAtId={initialAtId}
    />
  );
}
