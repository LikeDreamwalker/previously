"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSlicePageWithContent,
  type SliceWithContent,
} from "@/lib/episodic/actions";
import { prependPage } from "@/lib/chat/stream-items";
import { getStreamCache, setStreamCache } from "@/lib/chat/slice-cache";

/** Slices per page — a page is also the seam-anchored prepend unit (§1.4). */
export const SLICE_PAGE_SIZE = 10;
/** Safety bound for the "page until the target slice is loaded" jump loop —
 *  sparse catalogs could otherwise page forever (design §10). */
const MAX_JUMP_PAGES = 50;

export interface SliceStream {
  /** Loaded historical slices, oldest → newest (the still-alive newest slice
   *  is excluded when `before` pins the initial cursor — see chat-page). */
  slices: SliceWithContent[];
  hasMore: boolean;
  loadingOlder: boolean;
  /** True once the first page (or a cache restore) has landed. */
  initialLoaded: boolean;
  /**
   * Prepend one older page. Resolves to the exact number of STREAM ITEMS the
   * prepend adds (seams + turns) — the delta the caller must subtract from
   * Virtuoso's firstItemIndex to hold the scroll position. 0 when nothing was
   * added (exhausted, in flight, or a failed fetch).
   */
  loadOlder: () => Promise<number>;
  /**
   * Page backwards until `sliceId` is loaded (wheel jump to an unloaded
   * slice). `onPrepend` fires after each page with the exact stream-item
   * delta — the caller shifts Virtuoso's firstItemIndex by it. Resolves true
   * when the slice is in the loaded window; false when the catalog was
   * exhausted (or paging stalled) without it.
   */
  loadUntilSlice: (
    sliceId: string,
    onPrepend?: (addedItemCount: number) => void,
  ) => Promise<boolean>;
}

/**
 * Catalog-paged slice window for the unified message stream (v0.10 §1.5/§1.6).
 *
 * `initialBefore` pins the FIRST page's cursor (ISO `start` exclusive): the
 * chat page passes the resumed slice's start so the still-alive slice never
 * double-renders (its turns arrive via getArrivalState / the reconnect stash).
 * Loaded pages snapshot into slice-cache (5 min TTL) so a remount restores
 * instantly.
 */
export function useSliceStream(
  persona: string,
  initialBefore: string | null,
): SliceStream {
  // Restore the cached window SYNCHRONOUSLY (lazy initializer) — the stream
  // list mounts with it in place, so a cached restore never looks like an
  // un-shifted prepend (which would jump the scroll position).
  const [initial] = useState(() => {
    const cached = getStreamCache(persona);
    return {
      slices: cached?.slices ?? [],
      hasMore: cached?.hasMore ?? true,
      restored: cached !== null,
    };
  });
  const [slices, setSlices] = useState<SliceWithContent[]>(initial.slices);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(initial.restored);

  // Refs mirror the state so the async callbacks never close over staleness.
  const slicesRef = useRef<SliceWithContent[]>(initial.slices);
  const hasMoreRef = useRef(initial.hasMore);
  const loadingRef = useRef(false);
  // The cursor for the NEXT page: the oldest loaded slice's start, or the
  // initial pin while nothing is loaded yet.
  const initialBeforeRef = useRef<string | null>(initialBefore);

  const applyPage = useCallback(
    (page: { slices: SliceWithContent[]; hasMore: boolean }): number => {
      const { slices: next, addedItemCount } = prependPage(
        slicesRef.current,
        page.slices,
      );
      slicesRef.current = next;
      hasMoreRef.current = page.hasMore;
      setSlices(next);
      setHasMore(page.hasMore);
      setStreamCache(persona, next, page.hasMore);
      return addedItemCount;
    },
    [persona],
  );

  const loadOlder = useCallback(async (): Promise<number> => {
    if (loadingRef.current || !hasMoreRef.current) return 0;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const cursor =
        slicesRef.current.length > 0
          ? slicesRef.current[0].start
          : initialBeforeRef.current;
      const page = await getSlicePageWithContent(
        cursor,
        SLICE_PAGE_SIZE,
        persona,
      );
      return applyPage(page);
    } catch {
      return 0; // paging is best-effort — the next scroll retries
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [persona, applyPage]);

  const loadUntilSlice = useCallback(
    async (
      sliceId: string,
      onPrepend?: (addedItemCount: number) => void,
    ): Promise<boolean> => {
      // A jump can race the initial fill (or a startReached page): never
      // mistake "another page is in flight" for a failed fetch — wait it out.
      const waitForIdle = () =>
        new Promise<void>((resolve) => {
          const check = () =>
            loadingRef.current ? setTimeout(check, 50) : resolve();
          check();
        });
      for (let i = 0; i < MAX_JUMP_PAGES; i++) {
        if (slicesRef.current.some((s) => s.id === sliceId)) return true;
        if (!hasMoreRef.current) return false;
        if (loadingRef.current) {
          await waitForIdle();
          continue;
        }
        const beforeCount = slicesRef.current.length;
        const added = await loadOlder();
        // No progress (exhausted mid-loop or a failed fetch) — stop instead
        // of hammering the server for the remaining page budget.
        if (slicesRef.current.length === beforeCount) return false;
        onPrepend?.(added);
      }
      return slicesRef.current.some((s) => s.id === sliceId);
    },
    [loadOlder],
  );

  // Initial fill — only when no cached window was restored. (Persona is fixed
  // per mount: it comes from the URL and a switch reloads the page state.)
  useEffect(() => {
    if (initial.restored) return;
    let cancelled = false;
    void loadOlder().finally(() => {
      if (!cancelled) setInitialLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, loadOlder]);

  return { slices, hasMore, loadingOlder, initialLoaded, loadOlder, loadUntilSlice };
}
