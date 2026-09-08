"use client";

import { useEffect, useState } from "react";
import { getSliceContent } from "@/lib/episodic/actions";
import type { Turn } from "@/lib/episodic/types";

/**
 * SliceContent (Rev 1) — module-level content cache + component hook for the
 * 3D card field.
 *
 * Each card face used to receive its turn content from a `Map<string, ContentSlot>`
 * held in `CardField` state. That meant every visible slice resolve triggered a
 * top-down re-render of the whole R3F scene and produced the field-wide flicker
 * seen while scrolling. Now content lives in a module cache and each card
 * subscribes independently via `useSliceTurns(id)`:
 *
 * - Concurrent requests for the same slice are deduped (`inflight`).
 * - Cache survives unmount so scrolling back and forth does not re-fetch.
 * - A simple cap evicts the oldest entries when the cache grows too large.
 * - Failures are sticky (no retry loop per card).
 */
export interface SliceContent {
  state: "loading" | "ready" | "failed";
  turns?: Turn[];
  previously?: string | null;
  summary?: string;
  open_loops?: string[];
  decisions?: string[];
}

const cache = new Map<string, SliceContent>();
const inflight = new Map<string, Promise<void>>();
const CACHE_CAP = 200;

function trimCache(): void {
  if (cache.size <= CACHE_CAP) return;
  // Map iteration order is insertion order; evict the oldest entries.
  const over = cache.size - CACHE_CAP;
  let removed = 0;
  for (const key of cache.keys()) {
    if (removed >= over) break;
    cache.delete(key);
    removed++;
  }
}

/**
 * Hook that returns the cached/loading turn content for a single slice.
 * Triggers one module-level fetch when the slice is first requested and keeps
 * the result available for future mounts.
 */
export function useSliceTurns(id: string): SliceContent {
  const [slot, setSlot] = useState<SliceContent>(() => {
    const hit = cache.get(id);
    return hit && hit.state !== "loading" ? hit : { state: "loading" };
  });

  useEffect(() => {
    const hit = cache.get(id);
    if (hit && hit.state !== "loading") {
      setSlot(hit);
      return;
    }

    if (!inflight.has(id)) {
      cache.set(id, { state: "loading" });
      trimCache();
      const p = getSliceContent(id)
        .then((c) => {
          cache.set(id, {
            state: c ? "ready" : "failed",
            turns: c?.turns,
            previously: c?.previously,
            summary: c?.summary,
            open_loops: c?.open_loops,
            decisions: c?.decisions,
          });
        })
        .catch(() => {
          cache.set(id, { state: "failed" });
        })
        .finally(() => {
          inflight.delete(id);
        });
      inflight.set(id, p);
    }

    let alive = true;
    inflight.get(id)!.then(() => {
      if (!alive) return;
      setSlot(cache.get(id) ?? { state: "failed" });
    });

    return () => {
      alive = false;
    };
  }, [id]);

  return slot;
}
