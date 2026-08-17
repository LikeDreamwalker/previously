/**
 * Timeline types — the first-class derived index over time slices.
 *
 * v0.8: the timeline is a PROJECTION of the slice files, never a separately
 * maintained truth. `memory/episodic/timeline/index.json` is the canonical
 * structured catalog (renderable by the UI); `memory/episodic/timeline.md` is
 * its markdown projection (read by the main agent / recall). Both are rebuilt
 * by `weaveTimeline` in `weave.ts`.
 */

/** A single slice's catalog entry — the semantic "profile" that lets a reader
 *  judge relevance without opening the slice. Enriched by close-marking; a dry
 *  entry (empty focus+summary) carries `needs_marking: true`. */
export interface TimelineSliceEntry {
  /** Slice id, e.g. "2026-08-11-1115". */
  id: string;
  /** Calendar date "YYYY-MM-DD" (derived from id). */
  date: string;
  /** UTC ISO 8601 start. */
  start: string;
  /** UTC ISO 8601 end (absent while active). */
  end?: string;
  /** Number of turns; only known when the slice was parsed this run. */
  turn_count?: number;
  status: "active" | "closed";
  /** One-sentence focus (strong verb, not a noun label). */
  focus: string;
  /** What happened / key decisions. */
  summary: string;
  tags: string[];
  /** Emotional tone of the session, when marked. */
  tone?: string;
  open_loops: string[];
  decisions: string[];
  /** Strands (tags woven across slices) this slice carries. */
  strands: string[];
  /** True when focus/summary are both empty — needs the semantic fill worker. */
  needs_marking: boolean;
}

/** The canonical catalog file (`timeline/index.json`). */
export interface TimelineIndex {
  _schema: number;
  updated_at: string;
  slice_count: number;
  needs_marking: number;
  slices: TimelineSliceEntry[];
}

/** What a `weaveTimeline` run changed. */
export interface TimelineWeaveResult {
  /** Slices found on disk but absent from the projection — added. */
  added: number;
  /** Slices in the projection but absent on disk — dropped (phantom). */
  removed: number;
  /** Slices whose `needs_marking` flag flipped to true this run. */
  newly_dry: number;
  /** Total slices still needing semantic marking. */
  needs_marking: number;
  /** Total slices in the catalog. */
  total: number;
  /** True when the run skipped the full reconcile (throttled, still fresh). */
  skipped: boolean;
}
