/**
 * Client-side cache for historical slice content.
 *
 * Switching slices in the horizontal timeline re-fetches content from server
 * actions on every click without a cache. This module provides a simple
 * in-memory Map with a 5-minute TTL so quick back-and-forth navigation
 * doesn't re-fetch the same data.
 *
 * New messages never invalidate history — past slices are immutable once
 * closed, so the cache only evicts on TTL expiry.
 */

import type { SliceContent } from "@/lib/episodic/actions";

export interface CacheEntry {
  content: SliceContent;
  previously: string | null;
  fetchedAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, CacheEntry>();

/** Get a cached entry if still fresh. Returns null on miss or expiry. */
export function getCached(sliceId: string): CacheEntry | null {
  const entry = cache.get(sliceId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(sliceId);
    return null;
  }
  return entry;
}

/** Store a slice in the cache. */
export function setCache(
  sliceId: string,
  content: SliceContent,
  previously: string | null,
): void {
  cache.set(sliceId, { content, previously, fetchedAt: Date.now() });
}

/** Evict entries older than TTL. Call periodically or on navigation. */
export function evictOld(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > TTL_MS) {
      cache.delete(key);
    }
  }
}

/** Clear all cached entries (e.g. on persona switch). */
export function clearCache(): void {
  cache.clear();
}
