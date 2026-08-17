/**
 * weaveTimeline — the engineering reconciliation that keeps the timeline a
 * true projection of the slice files.
 *
 * Slices are the single source of truth; the timeline (index.json + timeline.md)
 * is always rebuilt from them, so a slice can never become unreachable because
 * "the timeline lost it", and a phantom timeline entry never points at nothing.
 *
 * Steps: ENUMERATE the actual slice dirs → LOAD the current projection →
 * DIFF (add missing slices from frontmatter, drop phantom entries) → REBUILD
 * and write both views. Pure engineering: no model calls.
 *
 * Throttling: a full reconcile (one recursive tree walk on GitHub) is skipped
 * while `index.json` is fresh, so per-turn calls are a single cached read. The
 * slice-close path forces a reconcile so a just-closed slice is visible
 * immediately.
 */
import { fsReadFile, type WriteBatch } from "../io-helpers";
import { enumerateSliceIds } from "./enumerate";
import {
  TIMELINE_MD_PATH,
  monthlyIndexPath,
  readTimelineIndex,
  sliceEntryFromDisk,
  writeTimelineIndex,
  writeTimelineMd,
} from "./store";
import { renderTimelineMd } from "./render";
import type {
  TimelineIndex,
  TimelineSliceEntry,
  TimelineWeaveResult,
} from "./types";

const STRANDS_PATH = "memory/episodic/strands.json";

/** Skip the full reconcile while the projection is this fresh. */
export const WEAVE_FRESH_MS = 5 * 60 * 1000;

// ─── Strand resolution ─────────────────────────────────────────────────

/** The strand index, read ONCE per weave (not once per slice). */
async function readStrandIndex(batch?: WriteBatch): Promise<Set<string>> {
  try {
    const raw = await fsReadFile(STRANDS_PATH, batch);
    const strands = JSON.parse(raw) as Record<string, unknown>;
    return new Set(Object.keys(strands));
  } catch {
    return new Set();
  }
}

/** tags that exist in the strand index → the slice's strand set. */
function resolveStrands(tags: string[], strandNames: Set<string>): string[] {
  return tags.filter((t) => strandNames.has(t));
}

// ─── Migration: build the projected map from legacy monthly _index.json ─

async function readMonthlyIndices(batch?: WriteBatch): Promise<Map<string, TimelineSliceEntry>> {
  const map = new Map<string, TimelineSliceEntry>();
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    let m = now.getUTCMonth() + 1 - i;
    let y = now.getUTCFullYear();
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    let raw: string;
    try {
      raw = await fsReadFile(monthlyIndexPath(y, m), batch);
    } catch {
      continue; // month has no index yet
    }
    try {
      const parsed = JSON.parse(raw) as { slices?: Array<Record<string, unknown>> };
      for (const e of parsed.slices ?? []) {
        const id = typeof e.id === "string" ? e.id : "";
        if (!id || !id.includes("-")) continue;
        const focus = typeof e.focus === "string" ? e.focus : "";
        const summary = typeof e.summary === "string" ? e.summary : "";
        map.set(id.split("-").join("/"), {
          id,
          date: id.slice(0, 10),
          start: typeof e.start === "string" ? e.start : "",
          status: e.status === "closed" ? "closed" : "active",
          focus,
          summary,
          tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
          open_loops: Array.isArray(e.open_loops) ? e.open_loops.map(String) : [],
          decisions: Array.isArray(e.decisions) ? e.decisions.map(String) : [],
          strands: [],
          needs_marking: !focus && !summary,
        });
      }
    } catch {
      // skip a malformed month index
    }
  }
  return map;
}

// ─── The weave ─────────────────────────────────────────────────────────

export async function weaveTimeline(
  opts: { force?: boolean } = {},
  batch?: WriteBatch,
): Promise<TimelineWeaveResult> {
  const existing = await readTimelineIndex(batch);

  // Throttle: the projection is fresh — skip the full reconcile.
  if (!opts.force && existing) {
    const age = Date.now() - Date.parse(existing.updated_at);
    if (!Number.isNaN(age) && age < WEAVE_FRESH_MS) {
      return {
        added: 0,
        removed: 0,
        newly_dry: 0,
        needs_marking: existing.needs_marking,
        total: existing.slice_count,
        skipped: true,
      };
    }
  }

  // 1. ENUMERATE the actual slice dirs (the truth).
  const actual = new Set(await enumerateSliceIds());

  // 2. LOAD the current projection (index.json, or migrate from monthly
  //    indices on first run).
  let projected = new Map<string, TimelineSliceEntry>();
  if (existing) {
    for (const s of existing.slices) {
      projected.set(s.id.split("-").join("/"), s);
    }
  } else {
    projected = await readMonthlyIndices(batch);
  }

  // 3. DIFF + rebuild.
  //
  // For slices already in the projection we REUSE the entry (no re-read) —
  // EXCEPT for slices whose frontmatter may have gained semantics since the
  // entry was written: the just-closed slice of today (close-marking writes
  // focus/summary at close) and slices still flagged needs_marking (the fill
  // worker writes them). Re-reading only those keeps the reconcile bounded.
  const today = new Date().toISOString().slice(0, 10);
  const entries: TimelineSliceEntry[] = [];
  let added = 0;
  let newlyDry = 0;
  for (const rel of actual) {
    const prior = projected.get(rel);
    if (prior) {
      const mayHaveNewSemantics = prior.needs_marking || prior.date === today;
      if (mayHaveNewSemantics) {
        const refreshed = await sliceEntryFromDisk(rel, batch);
        if (refreshed) {
          // Pick up semantics written after the entry was created (close-marking
          // on today's slice, or the needs_marking fill worker).
          const nowDry = !refreshed.focus && !refreshed.summary;
          entries.push({ ...prior, ...refreshed, strands: prior.strands, needs_marking: nowDry });
          continue;
        }
      }
      const dry = !prior.focus && !prior.summary;
      if (dry && !prior.needs_marking) newlyDry += 1;
      entries.push({ ...prior, needs_marking: dry });
    } else {
      // A slice on disk the projection never saw (crash before index write,
      // orphaned active slice, first run) — read its frontmatter once.
      const fresh = await sliceEntryFromDisk(rel, batch);
      if (!fresh) continue;
      added += 1;
      entries.push(fresh);
    }
  }

  let removed = 0;
  for (const rel of projected.keys()) {
    if (!actual.has(rel)) removed += 1;
  }

  // 4. Resolve strand membership (strands.json read once) + sort chronologically.
  const strandNames = await readStrandIndex(batch);
  for (const entry of entries) {
    entry.strands = resolveStrands(entry.tags, strandNames);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  const needsMarking = entries.filter((e) => e.needs_marking).length;
  const idx: TimelineIndex = {
    _schema: 1,
    updated_at: new Date().toISOString(),
    slice_count: entries.length,
    needs_marking: needsMarking,
    slices: entries,
  };

  // 5. Write both views. Inside a batch (turn) these land in the same commit.
  await writeTimelineIndex(idx, batch);
  await writeTimelineMd(renderTimelineMd(idx), batch);

  return {
    added,
    removed,
    newly_dry: newlyDry,
    needs_marking: needsMarking,
    total: entries.length,
    skipped: false,
  };
}

/** The markdown projection — kept at the path the recall agent reads. */
export async function readTimelineMd(): Promise<string> {
  try {
    return await fsReadFile(TIMELINE_MD_PATH);
  } catch {
    return "";
  }
}
