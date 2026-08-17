/**
 * Timeline store — paths, I/O, and slice→entry conversion for the catalog.
 *
 * Keep this module dependency-light (gray-matter + io-helpers + turn-parser
 * only) so it never forms a cycle with manager.ts.
 */
import matter from "gray-matter";
import { fsReadFile, fsWriteFile, type WriteBatch } from "../io-helpers";
import { parseTurns } from "../turn-parser";
import { renderTimelineMd } from "./render";
import type { TimeSlice } from "../types";
import type {
  TimelineIndex,
  TimelineSliceEntry,
} from "./types";

/** Canonical structured catalog. */
export const TIMELINE_INDEX_PATH = "memory/episodic/timeline/index.json";
/** Markdown projection — kept at the legacy path the recall agent reads. */
export const TIMELINE_MD_PATH = "memory/episodic/timeline.md";

/** A slice's core.md path from its relative path "YYYY/MM/DD/HHMM". */
export function sliceCorePath(relPath: string): string {
  return `memory/episodic/slices/${relPath}/timeline/core.md`;
}

/** A monthly _index.json path (same layout as manager.ts's getIndexPath). */
export function monthlyIndexPath(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `memory/episodic/slices/${year}/${mm}/_index.json`;
}

/** Coerce YAML values — gray-matter parses "A: B" strings as objects. */
function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === "string" ? e : str(e))).filter(Boolean);
}

/**
 * Build a catalog entry by reading a slice's core.md frontmatter.
 * Reads the full file (bounded — only called for slices missing from the
 * projection, typically a handful).
 */
export async function sliceEntryFromDisk(relPath: string, batch?: WriteBatch): Promise<TimelineSliceEntry | null> {
  const [y, m, d, hm] = relPath.split("/");
  try {
    const raw = await fsReadFile(sliceCorePath(relPath), batch);
    const { data } = matter(raw);
    // parseTurns handles the frontmatter itself — pass the full file.
    const { turns } = parseTurns(raw);
    const focus = str(data.focus);
    const summary = str(data.summary);
    const tags = strArr(data.tags);
    const start = str(data.start);
    const status = (data.status === "closed" ? "closed" : "active") as
      | "closed"
      | "active";
    return {
      id: `${y}-${m}-${d}-${hm}`,
      date: `${y}-${m}-${d}`,
      start: start || `${y}-${m}-${d}T00:00:00.000Z`,
      ...(data.end ? { end: str(data.end) } : {}),
      turn_count: turns.length,
      status,
      focus,
      summary,
      tags,
      ...(data.emotional_tone ? { tone: str(data.emotional_tone) } : {}),
      open_loops: strArr(data.open_loops),
      decisions: strArr(data.decisions),
      // strands = the tags that exist in the global strand index — resolved
      // during the weave (store does not read strands.json here).
      strands: [],
      needs_marking: !focus && !summary,
    };
  } catch {
    return null; // core.md missing / unreadable — caller skips it
  }
}

/** Read the canonical catalog. Returns null when it doesn't exist yet. */
export async function readTimelineIndex(batch?: WriteBatch): Promise<TimelineIndex | null> {
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH, batch);
    const parsed = JSON.parse(raw) as TimelineIndex;
    if (!parsed || !Array.isArray(parsed.slices)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the canonical catalog. */
export async function writeTimelineIndex(idx: TimelineIndex, batch?: WriteBatch): Promise<void> {
  await fsWriteFile(TIMELINE_INDEX_PATH, JSON.stringify(idx, null, 2), batch);
}

/** Write the markdown projection. */
export async function writeTimelineMd(content: string, batch?: WriteBatch): Promise<void> {
  await fsWriteFile(TIMELINE_MD_PATH, content, batch);
}

/**
 * Upsert one in-memory slice into the catalog + markdown projection — the
 * cheap alternative to a forced weave for a slice created THIS turn (the
 * throttled per-turn weave would otherwise defer its appearance for minutes).
 * No-op when no catalog exists yet (the next weave builds it from disk).
 * Strands are preserved from any prior entry; a fresh slice starts empty and
 * the next full weave reconciles them.
 */
export async function upsertTimelineEntry(
  slice: TimeSlice,
  batch?: WriteBatch,
): Promise<void> {
  const idx = await readTimelineIndex(batch);
  if (!idx) return;

  const prior = idx.slices.find((s) => s.id === slice.slice_id);
  const entry: TimelineSliceEntry = {
    id: slice.slice_id,
    date: slice.slice_id.slice(0, 10),
    start: slice.start,
    ...(slice.end ? { end: slice.end } : {}),
    turn_count: slice.turns.length,
    status: slice.status,
    focus: slice.focus,
    summary: slice.summary,
    tags: [...slice.tags],
    ...(slice.emotional_tone ? { tone: slice.emotional_tone } : {}),
    open_loops: [...slice.open_loops],
    decisions: [...slice.decisions],
    strands: prior?.strands ?? [],
    needs_marking: !slice.focus && !slice.summary,
  };

  const rest = idx.slices.filter((s) => s.id !== slice.slice_id);
  const slices = [...rest, entry].sort((a, b) => a.id.localeCompare(b.id));
  const next: TimelineIndex = {
    ...idx,
    updated_at: new Date().toISOString(),
    slice_count: slices.length,
    needs_marking: slices.filter((s) => s.needs_marking).length,
    slices,
  };
  await writeTimelineIndex(next, batch);
  await writeTimelineMd(renderTimelineMd(next), batch);
}
