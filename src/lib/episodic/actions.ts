"use server";

import { readSliceIndex, readSliceBody, parseSlice, sliceIdToFilePath, readPreviously, readAgentTimeline } from "./manager";
import type { Turn } from "./types";

export interface SliceSummary {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  status: "active" | "closed";
  open_loops: string[];
  decisions: string[];
  turnCount?: number;
  timezone?: string;
}

export interface EpisodicState {
  hasActiveSlice: boolean;
  hasMore: boolean;
  active: SliceSummary | null;
  recent: SliceSummary[];
}

const SCAN_BATCH = 6;

/**
 * Scan monthly indexes backwards from (startYear, startMonth), reading each
 * batch of months CONCURRENTLY (not one round-trip at a time — that's what made
 * the timeline slow over the GitHub API). Stops early once `enough` entries are
 * collected, so cost is bounded by "batches until enough found".
 */
async function scanMonthsBack(
  startYear: number,
  startMonth: number,
  maxMonths: number,
  enough: number,
): Promise<{ entries: Awaited<ReturnType<typeof readSliceIndex>>; exhausted: boolean }> {
  const entries: Awaited<ReturnType<typeof readSliceIndex>> = [];
  let scanned = 0;
  let exhausted = true;

  while (scanned < maxMonths) {
    const size = Math.min(SCAN_BATCH, maxMonths - scanned);
    const batch: Array<{ y: number; m: number }> = [];
    for (let j = 0; j < size; j++) {
      let m = startMonth - (scanned + j);
      let y = startYear;
      while (m <= 0) { m += 12; y -= 1; }
      batch.push({ y, m });
    }
    const results = await Promise.all(
      batch.map(({ y, m }) => readSliceIndex(y, m).catch(() => [])),
    );
    for (const idx of results) for (const e of idx) entries.push(e);
    scanned += size;
    if (entries.length >= enough) { exhausted = false; break; }
  }

  return { entries, exhausted };
}

export async function getEpisodicState(): Promise<EpisodicState & { hasMore: boolean }> {
  const PAGE_SIZE = 3;

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // Scan back until we find enough slices or hit the floor (120 months = 10 years).
  // Don't stop at an arbitrary recent-month window — the latest slice could be
  // anywhere in the timeline (especially with seeded demo data).
  const { entries, exhausted } = await scanMonthsBack(
    year,
    month,
    120,
    PAGE_SIZE + 2,
  );

  const sorted = entries.sort((a, b) => b.start.localeCompare(a.start));
  const recent = sorted.slice(0, PAGE_SIZE);
  const hasMore = sorted.length > PAGE_SIZE || !exhausted;
  const first = recent[0];

  return {
    hasActiveSlice: recent.length > 0,
    hasMore,
    active: first
      ? {
          slice_id: first.id,
          focus: first.focus,
          summary: first.summary,
          start: first.start,
          status: first.status as "active" | "closed",
          open_loops: first.open_loops,
          decisions: first.decisions,
        }
      : null,
    recent: recent.map((s) => ({
      slice_id: s.id,
      focus: s.focus,
      summary: s.summary,
      start: s.start,
      status: s.status as "active" | "closed",
      open_loops: s.open_loops,
      decisions: s.decisions,
    })),
  };
}

export interface SlicePage {
  slices: SliceSummary[];
  hasMore: boolean;
}

export async function getMoreSlices(
  before: string,
  limit: number = 10
): Promise<SlicePage> {
  // Walk back through monthly indexes (batched + concurrent) until we fill a
  // page or run out of history — up to 48 months so load-more can page across
  // month/year boundaries.
  const cap = Math.min(limit, 50);
  const beforeDate = new Date(before);
  const beforeYear = beforeDate.getUTCFullYear();
  const beforeMonth = beforeDate.getUTCMonth() + 1;

  const { entries } = await scanMonthsBack(beforeYear, beforeMonth, 48, cap);

  const filtered = entries
    .filter((e) => e.start < before)
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, cap);

  return {
    slices: filtered.map((s) => ({
      slice_id: s.id,
      focus: s.focus,
      summary: s.summary,
      start: s.start,
      status: s.status as "active" | "closed",
      open_loops: s.open_loops,
      decisions: s.decisions,
    })),
    hasMore: filtered.length === cap,
  };
}

export interface SliceContent {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  status: string;
  turns: Turn[];
  totalTurns: number;
  totalChars: number;
  open_loops: string[];
  decisions: string[];
}

export async function getSliceContent(
  sliceId: string
): Promise<SliceContent | null> {
  try {
    const path = sliceIdToFilePath(sliceId);
    const raw = await readSliceBody(path);
    const slice = parseSlice(raw);

    const totalChars = slice.turns.reduce(
      (sum, t) => sum + t.content.length,
      0
    );

    return {
      slice_id: slice.slice_id,
      focus: slice.focus,
      summary: slice.summary,
      start: slice.start,
      status: slice.status,
      turns: slice.turns,
      totalTurns: slice.turns.length,
      totalChars,
      open_loops: slice.open_loops,
      decisions: slice.decisions,
    };
  } catch (err) {
    console.error(`[Episodic] getSliceContent failed for ${sliceId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Previously / Agent Timeline actions ─────────────────────────────────

/**
 * Read the previously.md belief-system snapshot for a slice.
 * Returns null when the file doesn't exist (e.g. brand-new slice with no
 * previously.md seeded yet).
 */
export async function getPreviously(sliceId: string): Promise<string | null> {
  try {
    return await readPreviously(sliceId);
  } catch {
    return null;
  }
}

/**
 * Read the full agent.md cognition log for a slice.
 * Returns null when the file doesn't exist.
 */
export async function getAgentTimeline(sliceId: string): Promise<string | null> {
  try {
    return await readAgentTimeline(sliceId);
  } catch {
    return null;
  }
}

/**
 * Extract a single cognition block from agent.md by turnId.
 *
 * agent.md blocks follow the convention:
 *   ## Cognition {turnId} — {timestamp}
 *   (thinking + tool-call text…)
 *
 * Returns the body text (without the header line), or null when the turn
 * has no cognition recorded or the file doesn't exist.
 */
export async function getTurnCognition(
  sliceId: string,
  turnId: string,
): Promise<string | null> {
  try {
    const raw = await readAgentTimeline(sliceId);
    if (!raw) return null;

    // Split on cognition headers — each block starts with "## Cognition "
    const blocks = raw.split(/^## Cognition /m);
    for (const block of blocks) {
      if (block.startsWith(turnId)) {
        // Remove the "turnId — timestamp" header line
        const newlineIdx = block.indexOf("\n");
        if (newlineIdx === -1) return ""; // header only, no body
        return block.slice(newlineIdx + 1).trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}
