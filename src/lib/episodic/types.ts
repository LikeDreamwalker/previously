/** Status of a time slice — only one active at a time */
export type SliceStatus = "active" | "closed";

/** The four signals that can trigger a slice boundary */
export type SlicingSignal =
  | "time_silence"
  | "user_explicit"
  | "capacity";

/** Emotional tone of a time slice, maintained by Flash */
export type EmotionalTone =
  | "positive"
  | "neutral"
  | "negative"
  | "mixed";

// ─── Turn ────────────────────────────────────────────────────────────

/** A single message exchange within a time slice body */
export interface Turn {
  /** UTC ISO 8601 timestamp of this message */
  timestamp: string;
  /** "user" or "agent" */
  role: "user" | "agent";
  /** The message content (plain text or markdown) */
  content: string;
  /**
   * Shared by the user and agent turn in the same round.
   * 6-char base64url, e.g. "a3fk2w". Absent on legacy slices parsed from disk.
   */
  turnId?: string;
}

// ─── Frontmatter ─────────────────────────────────────────────────────

/** YAML frontmatter stored at the top of every time slice .md file */
export interface SliceFrontmatter {
  /** Unique identifier, format YYYY-MM-DD-HHMM (UTC date+time of first user message) */
  slice_id: string;
  /** Core topic, one sentence */
  focus: string;
  /** Current lifecycle status */
  status: SliceStatus;
  /** Start time in UTC ISO 8601 */
  start: string;
  /** End time in UTC ISO 8601 (set when closed) */
  end?: string;
  /** User's timezone at time of interaction, e.g. "Asia/Shanghai" */
  timezone: string;
  /** Flash-generated summary, at most 100 characters */
  summary: string;
  /** Unresolved questions carried forward */
  open_loops: string[];
  /** Decisions made during this slice */
  decisions: string[];
  /** Semantic tags */
  tags: string[];
  /** Paths of related slices, e.g. ["2026/06/22"] */
  related_slices: string[];
  /** loop run ids spawned from this slice */
  loops: string[];
  /** Emotional tone assessed by Flash on freeze */
  emotional_tone?: EmotionalTone;
}

// ─── Time Slice (in-memory) ──────────────────────────────────────────

/**
 * Full in-memory representation of a time slice.
 * Frontmatter fields are flattened at the top level for convenient access;
 * the canonical YAML rendering is derived from SliceFrontmatter.
 */
export interface TimeSlice {
  slice_id: string;
  focus: string;
  status: SliceStatus;
  start: string;
  end?: string;
  timezone: string;
  summary: string;
  open_loops: string[];
  decisions: string[];
  tags: string[];
  related_slices: string[];
  /** loop run ids spawned from this slice */
  loops: string[];
  emotional_tone?: EmotionalTone;
  /** Ordered list of turns that make up the slice body */
  turns: Turn[];
  /** Approximate token count of the entire slice (used for capacity signal) */
  estimatedTokens: number;
  /** The signal that caused this slice to close (only set when status is "closed") */
  closedBy?: SlicingSignal;
}

// ─── Index structures ────────────────────────────────────────────────

/** One entry in a monthly _index.json */
export interface SliceIndexEntry {
  /** Slice identifier in YYYY-MM-DD-HHMM format, e.g. "2026-07-02-1430" */
  id: string;
  focus: string;
  summary: string;
  tags: string[];
  status: SliceStatus;
  start: string;
  open_loops: string[];
  decisions: string[];
}

/** Monthly index stored as _index.json in each year/month directory */
export interface MonthlyIndex {
  month: string; // "YYYY-MM"
  slices: SliceIndexEntry[];
}

/**
 * Global strands.json structure — the keyword→slice index.
 *
 * A **strand** is a keyword woven through the time slices that carry it: this
 * maps each strand (a tag) to the relative slice paths threaded under it, so a
 * strand is "the whole history of that thing" across time. Slices carry `tags`
 * (the keywords); those tags weave into strands here.
 * Example: { "rust": ["2026/06/22/1400"], "async": ["2026/06/22/1400"] }
 */
export interface StrandIndex {
  [strand: string]: string[];
}
