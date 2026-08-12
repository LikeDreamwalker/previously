"use server";

import { getDemoPersona, listDemoPersonas, setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getUserName } from "@/lib/identity";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { readSliceIndex, readSliceBody, parseSlice, sliceIdToFilePath, readPreviously, readAgentTimeline } from "./manager";
import { readTimelineIndex } from "./timeline/store";
import type { TimelineSliceEntry } from "./timeline/types";
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

export async function getEpisodicState(persona?: string): Promise<EpisodicState & { hasMore: boolean }> {
  if (persona) setDemoPersona(persona);
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

/**
 * The full timeline catalog — every slice entry from `timeline/index.json`,
 * oldest → newest (the weave keeps it sorted ascending by id). This is the
 * "long array" the timeline wheel renders from (virtualized), not a paginated
 * page. Returns an empty array when the catalog hasn't been built yet.
 */
export async function getTimelineCatalog(): Promise<TimelineSliceEntry[]> {
  const idx = await readTimelineIndex();
  return idx?.slices ?? [];
}

// ─── Empty-state briefing identity ─────────────────────────────────────────
// The empty-live state shows a small "Previously On" + the user's name (+ a
// persona switcher in demo mode). No episodic re-scan here — ChatPage already
// loads the active slice via getEpisodicState; this only resolves the display
// name and, in demo mode, the persona list.
export interface BriefingIdentity {
  name: string;
  isDemo: boolean;
  personas?: Awaited<ReturnType<typeof listDemoPersonas>>;
}

export async function getBriefingIdentity(
  persona?: string,
): Promise<BriefingIdentity> {
  if (resolveDataSource() === "demo") {
    if (persona) setDemoPersona(persona);
    const personas = await listDemoPersonas().catch(() => []);
    const currentId = persona || getDemoPersona();
    const name = personas.find((p) => p.id === currentId)?.name ?? currentId;
    return { name, isDemo: true, personas };
  }
  const name = await getUserName().catch(() => "Previously");
  return { name, isDemo: false };
}

export async function getMoreSlices(
  before: string,
  limit: number = 10,
  persona?: string,
): Promise<SlicePage> {
  if (persona) setDemoPersona(persona);
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
  /** Previously.md content for this slice, or null if not found. */
  previously: string | null;
}

export async function getSliceContent(
  sliceId: string,
  persona?: string,
): Promise<SliceContent | null> {
  if (persona) setDemoPersona(persona);
  try {
    const path = sliceIdToFilePath(sliceId);
    const raw = await readSliceBody(path);
    const slice = parseSlice(raw);

    const totalChars = slice.turns.reduce(
      (sum, t) => sum + t.content.length,
      0
    );

    // Try to read previously.md for this slice — 404 / missing is normal
    let previously: string | null = null;
    try {
      previously = await readPreviously(sliceId);
    } catch {
      // previously.md doesn't exist for this slice
    }

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
      previously,
    };
  } catch (err) {
    console.error(`[Episodic] getSliceContent failed for ${sliceId}:`, formatErrorDetail(err));
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
