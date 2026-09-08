"use server";

import { getDemoPersona, listDemoPersonas, setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getUserName } from "@/lib/identity";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { readSliceIndex, readSliceBody, parseSlice, sliceIdToFilePath, readPreviously, readAgentTimeline, loadSlice } from "./manager";
import { readDirection } from "@/lib/evolution/store";
import { loadUserConfig } from "@/lib/config/loader";
import { readTimelineIndex } from "./timeline/store";
import { pageCatalog, type CatalogPage } from "./timeline/paginate";
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

export interface SliceWithContent {
  id: string;
  start: string;
  end?: string;
  focus: string;
  summary: string;
  tags: string[];
  strands: string[];
  turnCount: number;
  continuesFrom?: string;
  closedBy?: string;
  turns: Turn[];
}

export interface SliceContentPage {
  /** Slices in chronological order (oldest → newest), ready to prepend into the message stream. */
  slices: SliceWithContent[];
  /** True when the catalog still holds slices older than this page. */
  hasMore: boolean;
}

/**
 * One page of slices WITH their full turns (v0.10 unified message flow).
 *
 * The pagination source is the catalog (`timeline/index.json`, oldest →
 * newest): `before` is the ISO `start` of the oldest already-loaded slice
 * (null = initial page from the newest end); the page is the newest `limit`
 * entries whose `start < before`, returned oldest → newest. `hasMore` is
 * exact — derived from whether the catalog still holds older entries, not
 * from page-fill heuristics. Turns are filled in through the same read path
 * as `getSliceContent`; catalog entries whose slice file is missing
 * (phantoms) are skipped, never faked.
 */
export async function getSlicePageWithContent(
  before: string | null,
  limit: number = 10,
  persona?: string,
): Promise<SliceContentPage> {
  if (persona) setDemoPersona(persona);
  const cap = Math.max(1, Math.min(limit, 50));
  const idx = await readTimelineIndex();
  const catalog = idx?.slices ?? [];

  const eligible = before === null
    ? catalog
    : catalog.filter((e) => e.start < before);
  const pageEntries = eligible.slice(-cap);
  const hasMore = eligible.length > pageEntries.length;

  const loaded = await Promise.all(
    pageEntries.map(async (entry): Promise<SliceWithContent | null> => {
      const slice = await loadSlice(entry.id);
      if (!slice) return null;
      return {
        id: entry.id,
        start: entry.start,
        end: entry.end ?? slice.end,
        focus: entry.focus,
        summary: entry.summary,
        tags: entry.tags,
        strands: entry.strands,
        turnCount: slice.turns.length,
        continuesFrom: entry.continues_from,
        closedBy: entry.closed_by,
        turns: slice.turns,
      };
    }),
  );

  return {
    slices: loaded.filter((s): s is SliceWithContent => s !== null),
    hasMore,
  };
}

export type ArrivalState =
  | {
      mode: "resume";
      sliceId: string;
      turns: Turn[];
      focus: string;
      start: string;
    }
  | { mode: "briefing" };

/**
 * Arrival gate (v0.10 design §2): is the newest slice still alive?
 *
 * Reuses the server's own same-conversation criterion — `slicing.idleGapMinutes`
 * — so a config change moves both the close decision and the arrival decision
 * together. Last activity is the slice's last turn timestamp (falling back to
 * `end`, then `start`); younger than the idle gap → `resume` with the slice's
 * turns, otherwise → `briefing` (the existing EmptyBriefing path).
 */
export async function getArrivalState(persona?: string): Promise<ArrivalState> {
  if (persona) setDemoPersona(persona);
  const idx = await readTimelineIndex();
  const catalog = idx?.slices ?? [];
  const last = catalog[catalog.length - 1];
  if (!last) return { mode: "briefing" };

  const slice = await loadSlice(last.id);
  if (!slice) return { mode: "briefing" };

  const lastActivity =
    slice.turns[slice.turns.length - 1]?.timestamp ?? slice.end ?? slice.start;
  const { slicing } = await loadUserConfig();
  if (Date.now() - new Date(lastActivity).getTime() < slicing.idleGapMinutes * 60_000) {
    return {
      mode: "resume",
      sliceId: slice.slice_id,
      turns: slice.turns,
      focus: slice.focus,
      start: slice.start,
    };
  }
  return { mode: "briefing" };
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

/**
 * Month-windowed catalog (Rev 7 §R7.4): the 3D timeline pages its history —
 * the client loads the latest `months` months, then prefetches older windows
 * as the camera approaches the oldest loaded entry. The on-disk index stays
 * whole; the window only bounds what the client holds and lays out.
 */
export async function getTimelineCatalogPage(
  before: string | null,
  months = 2,
): Promise<CatalogPage> {
  const idx = await readTimelineIndex();
  return pageCatalog(idx?.slices ?? [], before, months);
}

/** One strand's selector row (Rev 8 §R8 筛选器). */
export interface StrandListItem {
  name: string;
  /** Slices carrying the strand. */
  count: number;
  /** UTC ISO start of the newest carrier — sort key for "最近活跃". */
  lastStart: string;
}

/**
 * The strand list for the timeline filter, aggregated from the FULL catalog
 * (the client's month window would miss strands that only appear in unloaded
 * history). Sorted by most recent activity first.
 */
export async function getStrandList(): Promise<StrandListItem[]> {
  const idx = await readTimelineIndex();
  const acc = new Map<string, StrandListItem>();
  for (const s of idx?.slices ?? []) {
    for (const name of s.strands) {
      const item = acc.get(name);
      if (item) {
        item.count += 1;
        if (s.start > item.lastStart) item.lastStart = s.start;
      } else {
        acc.set(name, { name, count: 1, lastStart: s.start });
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.lastStart.localeCompare(a.lastStart));
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

// ─── Memory docs viewer (previously / direction) ─────────────────────────

export interface MemoryDocs {
  /** The slice the previously.md snapshot belongs to (null when no slices exist). */
  sliceId: string | null;
  /** previously.md of the current slice — the latest slice when none is active. */
  previously: string | null;
  /** memory/evolution/direction.md */
  direction: string | null;
}

/**
 * Read the user-facing memory documents in one round-trip. The "current"
 * slice is simply the NEWEST slice — an active slice is always the newest (a
 * new slice only starts after the previous one closes), so this covers both
 * "the current slice" and "the latest slice when none is active".
 */
export async function getMemoryDocs(persona?: string): Promise<MemoryDocs> {
  if (persona) setDemoPersona(persona);

  const now = new Date();
  const { entries } = await scanMonthsBack(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    120,
    1,
  );
  const latest = entries.sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;

  const [previously, direction] = await Promise.all([
    latest ? readPreviously(latest.id).catch(() => null) : Promise.resolve(null),
    readDirection(),
  ]);

  return { sliceId: latest?.id ?? null, previously, direction };
}
