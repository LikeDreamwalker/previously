"use client";

import { useState, useCallback, useMemo } from "react";
import { getEpisodicState, getMoreSlices, type SliceSummary } from "@/lib/episodic/actions";

export type { SliceSummary };

interface TimelineState {
  active: SliceSummary | null;
  slices: SliceSummary[];
  hasMore: boolean;
  loadedIds: string[];
}

export function useTimeline(initialData?: Partial<TimelineState> | null) {
  // Initial data from server props — always up-to-date (RSC re-render → new props).
  // Extra data from loadMore — accumulated locally, appended to initial slices.
  const baseSlices = initialData?.slices ?? [];
  const baseActive = initialData?.active ?? null;
  const baseHasMore = initialData?.hasMore ?? false;

  const [extraSlices, setExtraSlices] = useState<SliceSummary[]>([]);
  const [extraHasMore, setExtraHasMore] = useState(baseHasMore);
  const [loadingMore, setLoadingMore] = useState(false);

  // When base slices change (persona switch), reset the extra accumulation.
  // We detect the change by comparing the first base slice id.
  const baseKey = baseSlices[0]?.slice_id ?? "";
  const [lastBaseKey, setLastBaseKey] = useState(baseKey);
  if (baseKey !== lastBaseKey) {
    setExtraSlices([]);
    setExtraHasMore(baseHasMore);
    setLastBaseKey(baseKey);
  }

  const slices = useMemo(
    () => [...baseSlices, ...extraSlices],
    [baseSlices, extraSlices],
  );

  const active = baseActive;
  const hasMore = extraHasMore;
  const loadedIds = useMemo(
    () => slices.map((s) => s.slice_id),
    [slices],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;

    const oldest = slices[slices.length - 1];
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const data = await getMoreSlices(oldest.start, 10);
      setExtraSlices((prev) => [...prev, ...(data.slices ?? [])]);
      setExtraHasMore(data.hasMore ?? false);
    } catch {
      // silently fail
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, slices]);

  // Loading state: true only when no initial data has been provided yet
  // (e.g. during SSR before the server action completes). When initialData
  // is present but empty, the timeline is genuinely empty — not loading.
  const loading = initialData == null;

  return {
    active,
    slices,
    loadedIds,
    loading,
    loadingMore,
    hasMore,
    loadMore,
  };
}
