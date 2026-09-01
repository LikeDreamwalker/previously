/**
 * Episodic Memory Manager — core CRUD for time slices.
 *
 * Tracks the active time slice in memory, computes file paths, serializes
 * slices to Markdown (YAML frontmatter + turns body), and maintains the
 * monthly index and global tag index on disk.
 *
 * All file I/O delegates to the existing tools layer, which handles the
 * local-dev vs GitHub-production switch transparently.
 */
import matter from "gray-matter";
import { getDemoPersona } from "@/lib/demo/demo-fs";
import { isDemo, resolveDataSource } from "@/lib/data-source/resolve";
import type {
  TimeSlice,
  Turn,
  SlicingSignal,
  SliceIndexEntry,
  SliceFrontmatter,
  MonthlyIndex,
  StrandIndex,
} from "./types";
import {
  fsReadFile,
  fsWriteFile,
  fsListFiles,
  type WriteBatch,
} from "./io-helpers";
import {
  newCardTemplate,
  migrateToV3,
  migrateV3ToCard,
  isCardFormat,
} from "./previously-format";
import { weaveTag } from "./strands";

// ─── Environment detection ───────────────────────────────────────────────

const DATA_SOURCE = resolveDataSource();
const DEMO_MODE = isDemo(DATA_SOURCE);

// ─── In-memory active slice tracking ─────────────────────────────────────

let activeSlice: TimeSlice | null = null;

/**
 * Get the currently active time slice, or null if none is open.
 */
export function getActiveSlice(): TimeSlice | null {
  return activeSlice;
}

/**
 * Create a new time slice and set it as the active one.
 * The slice_id is derived from the current UTC date at time of first message.
 * Does NOT write to disk — that happens when appendTurn or closeSlice is called.
 *
 * `continuesFrom` links the slice to the one it continues — set only when the
 * previous slice closed on a time_cap/capacity CHECKPOINT (the same ongoing
 * conversation), never on idle_gap/context_lost (a genuine new conversation).
 */
export function createSlice(userMessage: string, timezone: string, turnId: string, continuesFrom?: string): TimeSlice {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const sliceId = `${year}-${month}-${day}-${hh}${mm}`;
  const start = now.toISOString();

  const firstTurn: Turn = {
    timestamp: start,
    role: "user",
    content: userMessage,
    turnId,
  };

  const slice: TimeSlice = {
    slice_id: sliceId,
    focus: "",
    status: "active",
    start,
    timezone,
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    loops: [],
    turns: [firstTurn],
    estimatedTokens: Math.ceil(userMessage.length / 4),
    ...(continuesFrom ? { continuesFrom } : {}),
  };

  activeSlice = slice;
  return slice;
}

/**
 * Try to recover today's active time slice from disk/GitHub.
 * Used on page refresh — a day is a directory of slice files (DD/HHMM.md),
 * so we scan today's directory and return the most recent slice that is still
 * `active`. Returns null if the directory is missing or holds no active slice.
 */
export async function tryLoadTodaySlice(
  batch?: WriteBatch
): Promise<TimeSlice | null> {
  const now = new Date();
  const today = dirForDate(now);
  // A conversation that crosses the UTC day boundary (00:00 UTC = 08:00 in
  // UTC+8 — morning chats) lives in YESTERDAY's directory. Without this
  // fallback the still-active slice is orphaned: never recovered, never
  // closed, never reviewed by evolution.
  const yesterday = dirForDate(new Date(now.getTime() - 86_400_000));
  return (
    (await scanDirForActiveSlice(today, batch)) ??
    (await scanDirForActiveSlice(yesterday, batch))
  );
}

/** Slice directory path for a UTC date: memory/episodic/slices/YYYY/MM/DD */
function dirForDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `memory/episodic/slices/${year}/${month}/${day}`;
}

/** Scan one day directory for the most recent slice still marked `active`. */
async function scanDirForActiveSlice(
  dir: string,
  batch?: WriteBatch
): Promise<TimeSlice | null> {
  try {
    const entries = await fsListFiles(dir);

    // NEW format: slice directories (HHMM/) containing timeline/core.md
    const sliceDirs = entries
      .filter((e) => e.type === "dir")
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const d of sliceDirs) {
      try {
        const corePath = `${dir}/${d.name}/timeline/core.md`;
        const raw = await fsReadFile(corePath, batch);
        const slice = parseSlice(raw);
        if (slice.status === "active") return slice;
      } catch {
        // core.md may not exist in this directory yet — skip
      }
    }

    // BACKWARD COMPAT: flat .md files (old format)
    const files = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const f of files) {
      const raw = await fsReadFile(f.path, batch);
      const slice = parseSlice(raw);
      if (slice.status === "active") return slice;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Close the active time slice, persisting it to disk and running
 * index maintenance. Returns the closed slice.
 */
export async function closeSlice(
  slice: TimeSlice,
  signal: SlicingSignal,
  batch?: WriteBatch
): Promise<TimeSlice> {
  slice.status = "closed";
  // The end of the conversation is the LAST TURN's timestamp, not the moment
  // this close executes — closes are lazy (the age cap is detected when the
  // NEXT session arrives, possibly hours later), so stamping "now" would
  // fabricate a false end and zero out the continuity gap.
  slice.end = slice.turns.at(-1)?.timestamp ?? new Date().toISOString();
  slice.closedBy = signal;

  // Persist the closed slice body to disk
  const slicePath = getSlicePath(slice);
  const markdown = serializeSlice(slice);
  await fsWriteFile(slicePath, markdown, batch);

  // Run index maintenance
  await updateMonthlyIndex(slice, batch);
  if (slice.tags.length > 0) {
    await updateStrands(slice, batch);
  }

  // Clear active if this was the active slice
  if (activeSlice?.slice_id === slice.slice_id) {
    activeSlice = null;
  }

  return slice;
}

// ─── Path computation ────────────────────────────────────────────────────

/**
 * Derive the slices-relative path (no `slices/` prefix, no `.md`) from a slice_id.
 * New format:  `YYYY-MM-DD-HHMM` → `YYYY/MM/DD/HHMM`
 * Legacy:      `YYYY-MM-DD`      → `YYYY/MM/DD`   (kept for robustness)
 */
export function sliceIdToRelPath(sliceId: string): string {
  const p = sliceId.split("-");
  return p.length >= 4
    ? `${p[0]}/${p[1]}/${p[2]}/${p[3]}`
    : `${p[0]}/${p[1]}/${p[2]}`;
}

/**
 * Compute the path to the slice's timeline directory (no trailing file).
 * New format: memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/
 */
export function sliceIdToTimelineDir(sliceId: string): string {
  return `memory/episodic/slices/${sliceIdToRelPath(sliceId)}/timeline`;
}

/**
 * Compute the file path for core.md (the shared conversation record).
 * New format: memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md
 */
export function sliceIdToFilePath(sliceId: string): string {
  return `${sliceIdToTimelineDir(sliceId)}/core.md`;
}

/**
 * Compute the file path for agent.md (the agent's internal cognitive record).
 * New format: memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/agent.md
 */
export function sliceIdToAgentPath(sliceId: string): string {
  return `${sliceIdToTimelineDir(sliceId)}/agent.md`;
}

/**
 * Compute the file path for previously.md (the agent's belief system about
 * the user). Lives at slice root — sibling to timeline/, not inside it.
 * Format: memory/episodic/slices/YYYY/MM/DD/HHMM/previously.md
 */
export function sliceIdToPreviouslyPath(sliceId: string): string {
  return `memory/episodic/slices/${sliceIdToRelPath(sliceId)}/previously.md`;
}

/**
 * Compute the file path for the active time slice's core.md.
 */
export function getSlicePath(slice: TimeSlice): string {
  return sliceIdToFilePath(slice.slice_id);
}

/**
 * Compute the path to a monthly _index.json file.
 * Format: memory/episodic/slices/YYYY/MM/_index.json
 */
export function getIndexPath(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `memory/episodic/slices/${year}/${mm}/_index.json`;
}

/**
 * Get the path to the global strands.json file (the keyword→slice index).
 */
export function getStrandsPath(): string {
  return "memory/episodic/strands.json";
}

// ─── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize a TimeSlice to a Markdown string with YAML frontmatter.
 * The frontmatter contains metadata; the body contains turn-by-turn content.
 */
export function serializeSlice(slice: TimeSlice): string {
  const frontmatter: SliceFrontmatter = {
    slice_id: slice.slice_id,
    focus: slice.focus,
    status: slice.status,
    start: slice.start,
    end: slice.end,
    timezone: slice.timezone,
    summary: slice.summary,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
    tags: slice.tags,
    related_slices: slice.related_slices,
    loops: slice.loops,
    emotional_tone: slice.emotional_tone,
    closed_by: slice.closedBy,
    evolution_summary: slice.evolutionSummary,
    continues_from: slice.continuesFrom,
  };

  // Remove undefined fields for clean YAML
  const cleanFm: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== "") {
      cleanFm[key] = value;
    }
  }

  const body = slice.turns
    .map(
      (turn) =>
        `## Turn ${turn.turnId ?? "?"} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`
    )
    .join("\n\n");

  return matter.stringify(body, cleanFm);
}

/**
 * Parse a Markdown string (with YAML frontmatter) back into a TimeSlice.
 */

/** Coerce a value that should be a string — YAML unquoted values with ": "
 *  can be parsed as objects by gray-matter. */
function normalizeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}

/** Coerce an array where every entry should be a string. */
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === "string" ? e : normalizeString(e)));
}

export function parseSlice(raw: string): TimeSlice {
  const { data, content } = matter(raw);

  const frontmatter = data as Partial<SliceFrontmatter>;

  // Parse turns from body content
  const turns = parseTurns(content);

  // Estimate tokens: rough 1 token per 4 characters
  const estimatedTokens = Math.ceil(raw.length / 4);

  // Normalize open_loops / decisions — YAML unquoted values containing ": "
  // (e.g. "Draft guide on the model: retention chain") are parsed as
  // key-value objects by gray-matter instead of strings. Coerce every
  // entry to a string so React rendering never receives an object.
  const open_loops = normalizeStringArray(frontmatter.open_loops);
  const decisions = normalizeStringArray(frontmatter.decisions);
  const tags = normalizeStringArray(frontmatter.tags);

  return {
    slice_id: frontmatter.slice_id ?? "",
    focus: normalizeString(frontmatter.focus) ?? "",
    status: frontmatter.status ?? "active",
    start: frontmatter.start ?? "",
    end: frontmatter.end,
    timezone: frontmatter.timezone ?? "UTC",
    summary: normalizeString(frontmatter.summary) ?? "",
    open_loops,
    decisions,
    tags,
    related_slices: normalizeStringArray(frontmatter.related_slices),
    loops: normalizeStringArray(frontmatter.loops),
    emotional_tone: frontmatter.emotional_tone as SliceFrontmatter["emotional_tone"],
    // v0.9: evolution summary frozen at slice birth, replayed into the L3
    // slice-head block on every turn of this slice (byte-stable prompt).
    evolutionSummary: normalizeString(frontmatter.evolution_summary) || undefined,
    // The checkpoint continuation link (a slice born from a time_cap/capacity
    // close of the same conversation) — drives the carry-over history prefix.
    continuesFrom: normalizeString(frontmatter.continues_from) || undefined,
    turns,
    estimatedTokens,
    // The real close signal round-trips through frontmatter since v0.8;
    // legacy closed slices lack `closed_by` and fall back to user_explicit.
    closedBy:
      frontmatter.status === "closed"
        ? isSlicingSignal(frontmatter.closed_by)
          ? frontmatter.closed_by
          : "user_explicit"
        : undefined,
  };
}

const SLICING_SIGNALS: readonly SlicingSignal[] = [
  "time_cap",
  // Legacy (pre-v0.9): inactivity-based closing. Kept so historical slices
  // with closed_by: time_silence are not misread as user_explicit.
  "time_silence",
  "user_explicit",
  "capacity",
  "context_lost",
  "idle_gap",
];

function isSlicingSignal(v: unknown): v is SlicingSignal {
  return typeof v === "string" && (SLICING_SIGNALS as readonly string[]).includes(v);
}

/**
 * Parse turn blocks from the Markdown body of a time slice.
 * Each turn starts with "## Turn {turnId} — ISO_TIMESTAMP (role)" (new) or
 * "## Turn N — ISO_TIMESTAMP (role)" (legacy, numeric index only).
 */
function parseTurns(body: string): Turn[] {
  const turns: Turn[] = [];
  const trimmed = body.trim();
  if (!trimmed) return turns;

  // Match both old and new formats:
  // New: ## Turn a3fk2w — ISO (role)
  // Legacy: ## Turn 1 — ISO (role)
  const turnHeaderRegex = /^## Turn (\S+) — (\S+) \((\w+)\)$/gm;

  // Collect turn headers with the position right after the header line
  const headers: Array<{
    turnLabel: string;
    timestamp: string;
    role: "user" | "agent";
    contentStart: number;
  }> = [];
  let match: RegExpExecArray | null;

  while ((match = turnHeaderRegex.exec(trimmed)) !== null) {
    const afterHeader =
      trimmed.indexOf("\n", match.index) === -1
        ? trimmed.length
        : trimmed.indexOf("\n", match.index) + 1;

    headers.push({
      turnLabel: match[1],
      timestamp: match[2],
      role: match[3] as "user" | "agent",
      contentStart: afterHeader,
    });
  }

  // Extract the content between each header and the next.
  // Search for "## Turn " as a generic delimiter — no longer relies on
  // sequential numeric indices (which don't exist with base64url turnIds).
  for (let i = 0; i < headers.length; i++) {
    const nextHeaderIdx = trimmed.indexOf("## Turn ", headers[i].contentStart);
    const contentEnd = nextHeaderIdx !== -1 ? nextHeaderIdx : trimmed.length;

    const turnContent = trimmed
      .slice(headers[i].contentStart, contentEnd)
      .trim();

    // Distinguish: numeric label → legacy format (no turnId), base64url → new
    const isNumeric = /^\d+$/.test(headers[i].turnLabel);

    turns.push({
      timestamp: headers[i].timestamp,
      role: headers[i].role,
      content: turnContent,
      ...(isNumeric ? {} : { turnId: headers[i].turnLabel }),
    });
  }

  return turns;
}

/**
 * Serialize a MonthlyIndex (array of SliceIndexEntry) to a JSON string.
 */
export function serializeIndex(
  entries: SliceIndexEntry[],
  month: string
): string {
  const index: MonthlyIndex = { month, slices: entries };
  return JSON.stringify(index, null, 2);
}

/**
 * Serialize a StrandIndex to a JSON string.
 */
export function serializeStrands(index: StrandIndex): string {
  return JSON.stringify(index, null, 2);
}

// ─── Turn management ─────────────────────────────────────────────────────

/**
 * Append a turn to the active slice in memory.
 * Does NOT write to disk — only updates in-memory state.
 * The caller is responsible for persisting at appropriate checkpoints.
 */
export function appendTurn(slice: TimeSlice, turn: Turn): void {
  slice.turns.push(turn);
  // Rough token estimate update
  slice.estimatedTokens += Math.ceil(turn.content.length / 4);
  // Overhead for turn header and structure
  slice.estimatedTokens += 8;
}

// ─── Reading slices ──────────────────────────────────────────────────────

/**
 * Read a monthly _index.json and return its entries.
 * Returns an empty array if the index file does not exist.
 */
async function readSliceIndexRaw(
  year: number,
  month: number,
  batch?: WriteBatch
): Promise<SliceIndexEntry[]> {
  const indexPath = getIndexPath(year, month);
  try {
    const raw = await fsReadFile(indexPath, batch);
    const parsed: MonthlyIndex = JSON.parse(raw);
    return parsed.slices ?? [];
  } catch {
    return [];
  }
}

// Persona-aware in-memory cache for demo mode. Keyed by persona + path so
// switching personas doesn't return stale data from the previous persona's
// cache. TTL: 1 hour (demo data is static; remote fetches have their own
// manifest-level cache in demo-fs.ts).

const _indexCache = new Map<string, { data: SliceIndexEntry[]; ttl: number }>();
const _bodyCache = new Map<string, { data: string; ttl: number }>();

function cacheGet<T>(store: Map<string, { data: T; ttl: number }>, key: string): T | null {
  const entry = store.get(key);
  if (entry && Date.now() < entry.ttl) return entry.data;
  store.delete(key);
  return null;
}

function cacheSet<T>(store: Map<string, { data: T; ttl: number }>, key: string, data: T): void {
  store.set(key, { data, ttl: Date.now() + 3_600_000 }); // 1 hour
}

export async function readSliceIndex(
  year: number,
  month: number,
  batch?: WriteBatch
): Promise<SliceIndexEntry[]> {
  if (DEMO_MODE) {
    const key = `${getDemoPersona()}:idx:${year}:${month}`;
    const cached = cacheGet(_indexCache, key);
    if (cached) return cached;
    const data = await readSliceIndexRaw(year, month, batch);
    cacheSet(_indexCache, key, data);
    return data;
  }
  return readSliceIndexRaw(year, month, batch);
}

/**
 * Read the global strands.json (keyword→slice index).
 * Returns an empty object if the strand index does not exist.
 */
export async function readStrands(batch?: WriteBatch): Promise<StrandIndex> {
  const strandsPath = getStrandsPath();
  try {
    const raw = await fsReadFile(strandsPath, batch);
    return JSON.parse(raw) as StrandIndex;
  } catch {
    return {};
  }
}

/**
 * Read the full body (Markdown with frontmatter) of a time slice from disk.
 */
export async function readSliceBody(path: string): Promise<string> {
  if (DEMO_MODE) {
    const key = `${getDemoPersona()}:body:${path}`;
    const cached = cacheGet(_bodyCache, key);
    if (cached) return cached;
    const data = await fsReadFile(path);
    cacheSet(_bodyCache, key, data);
    return data;
  }
  return fsReadFile(path);
}

/**
 * Load any slice (active or closed) by id — best-effort, null when the file
 * is missing or unreadable. Used for the checkpoint carry-over: a slice born
 * from a time_cap/capacity close re-reads its `continuesFrom` predecessor so
 * its tail can be prepended to the history window.
 */
export async function loadSlice(
  sliceId: string,
  batch?: WriteBatch,
): Promise<TimeSlice | null> {
  try {
    const raw = await fsReadFile(sliceIdToFilePath(sliceId), batch);
    return parseSlice(raw);
  } catch {
    return null;
  }
}

// ─── Index maintenance ───────────────────────────────────────────────────

/**
 * Build a SliceIndexEntry from a TimeSlice for storage in a monthly index.
 */
export function toIndexEntry(slice: TimeSlice): SliceIndexEntry {
  return {
    id: slice.slice_id,
    focus: slice.focus,
    summary: slice.summary,
    tags: slice.tags,
    status: slice.status,
    start: slice.start,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
  };
}

/**
 * Update (or create) the monthly _index.json for the slice's year/month.
 * Upserts the slice's index entry into the existing index.
 */
export async function updateMonthlyIndex(
  slice: TimeSlice,
  batch?: WriteBatch
): Promise<void> {
  const [yearStr, monthStr] = slice.slice_id.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const existing = await readSliceIndex(year, month, batch);
  const entry = toIndexEntry(slice);

  // Upsert: replace existing entry with same id, or append
  const idx = existing.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }

  // Sort by id ascending (YYYY-MM-DD-HHMM format sorts correctly as string)
  existing.sort((a, b) => a.id.localeCompare(b.id));

  const indexPath = getIndexPath(year, month);
  const json = serializeIndex(existing, `${yearStr}-${monthStr}`);
  await fsWriteFile(indexPath, json, batch);
}

/**
 * Weave the slice's tags into the global strands.json (keyword→slice index).
 * Each tag on the slice is a strand; register the slice's relative path under it.
 *
 * Merge-first: each tag lands under an existing normalized-matching strand when
 * one exists (never creating a near-duplicate); only a genuinely new tag creates
 * a new key (stored normalized). See `weaveTag` in strands.ts.
 */
export async function updateStrands(
  slice: TimeSlice,
  batch?: WriteBatch
): Promise<void> {
  const strands = await readStrands(batch);
  const relativePath = extractRelativePath(slice);

  for (const tag of slice.tags) {
    weaveTag(strands, tag, relativePath);
  }

  const strandsPath = getStrandsPath();
  const json = serializeStrands(strands);
  await fsWriteFile(strandsPath, json, batch);
}

/**
 * Extract the relative path segment from a slice's id (used by the tag index).
 * Example: "2026-06-30-1430" → "2026/06/30/1430"
 */
function extractRelativePath(slice: TimeSlice): string {
  return sliceIdToRelPath(slice.slice_id);
}

// ─── Agent timeline I/O ──────────────────────────────────────────────────

/**
 * Write (append) a cognition entry to the agent's timeline for a slice.
 * Reads the existing agent.md (if any) and appends the new entry.
 */
export async function writeAgentTimeline(
  sliceId: string,
  cognitionContent: string,
  batch?: WriteBatch,
): Promise<{ path: string; created: boolean }> {
  const agentPath = sliceIdToAgentPath(sliceId);
  let existing = "";
  try {
    existing = await fsReadFile(agentPath, batch);
  } catch {
    // File doesn't exist yet — will be created
  }
  const fullContent = existing.trimEnd()
    ? existing.trimEnd() + "\n\n" + cognitionContent
    : cognitionContent;
  return fsWriteFile(agentPath, fullContent, batch);
}

/**
 * Read the agent's cognitive timeline for a slice.
 * Returns empty string if agent.md doesn't exist.
 */
export async function readAgentTimeline(sliceId: string): Promise<string> {
  try {
    return await fsReadFile(sliceIdToAgentPath(sliceId));
  } catch {
    return "";
  }
}

// ─── Previously.md I/O ────────────────────────────────────────────────────

/** Empty previously.md template for slices with no prior beliefs (v3). */
export function emptyPreviouslyTemplate(sliceId: string): string {
  return newCardTemplate(sliceId);
}

/**
 * Read the raw previously.md content for a slice (no migration).
 * Returns "" if it doesn't exist yet. Internal — ensurePreviously uses it so
 * it can still detect and persist legacy files.
 */
async function readPreviouslyRaw(
  sliceId: string,
  batch?: WriteBatch
): Promise<string> {
  try {
    return await fsReadFile(sliceIdToPreviouslyPath(sliceId), batch);
  } catch {
    return "";
  }
}

/**
 * Read the previously.md content for a slice, always in the v3 format: legacy
 * (v1/v2) content is migrated on the fly so the model and every consumer see
 * one consistent structure. Returns "" if it doesn't exist yet.
 */
export async function readPreviously(sliceId: string): Promise<string> {
  const raw = await readPreviouslyRaw(sliceId);
  if (!raw) return "";
  // v4 card is read as-is (the current structure); legacy v1/v2/v3 content is
  // migrated on the fly so old slices stay readable.
  return isCardFormat(raw) ? raw : migrateToV3(raw, sliceId);
}

/**
 * Write (overwrite) previously.md content for a slice.
 */
export async function writePreviously(
  sliceId: string,
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(sliceIdToPreviouslyPath(sliceId), content, batch);
}

/**
 * Find the most recently frozen previously.md by scanning backward through
 * calendar days (up to 30). Returns the content migrated to the v3 format,
 * or null if no frozen previously.md exists within the lookback window.
 */
export async function findMostRecentPreviously(
  batch?: WriteBatch
): Promise<string | null> {
  const now = new Date();
  const MAX_DAYS = 30;

  for (let daysBack = 0; daysBack < MAX_DAYS; daysBack++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack));
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dir = `memory/episodic/slices/${year}/${month}/${day}`;

    try {
      const entries = await fsListFiles(dir);
      const sliceDirs = entries
        .filter((e) => e.type === "dir")
        .sort((a, b) => b.name.localeCompare(a.name)); // newest first

      for (const sd of sliceDirs) {
        try {
          const prevPath = `${dir}/${sd.name}/previously.md`;
          const content = await fsReadFile(prevPath, batch);
          if (content.trim()) {
            return isCardFormat(content) ? content : migrateToV3(content);
          }
        } catch {
          // No previously.md in this slice directory
        }
      }
    } catch {
      // Day directory doesn't exist
    }
  }

  return null;
}

/**
 * The LIVE previously card — the single source every turn injects into the
 * system prompt, maintained by evolution (slice close + explicit trigger).
 * Per-slice previously.md files remain as historical snapshots; this is the
 * current one the conversation actually reads.
 */
export const CURRENT_PREVIOUSLY_PATH = "memory/episodic/current-previously.md";

/** Read the live card. Returns "" if it doesn't exist yet. */
export async function readCurrentPreviously(
  batch?: WriteBatch
): Promise<string> {
  try {
    return await fsReadFile(CURRENT_PREVIOUSLY_PATH, batch);
  } catch {
    return "";
  }
}

/** Overwrite the live card. */
export async function writeCurrentPreviously(
  content: string,
  batch?: WriteBatch
): Promise<void> {
  await fsWriteFile(CURRENT_PREVIOUSLY_PATH, content, batch);
}

/**
 * Ensure the LIVE card exists and return it — every turn injects this.
 *
 * v0.7b synchronous design: the boundary turn evolves the live card BEFORE the
 * new slice is created, then this copies the live card to the new slice's
 * per-slice file — so the agent uses a freshly-evolved card, never a stale one.
 * The live card is seeded once from the latest snapshot (or a template), then
 * maintained by the inline evolution via `writeCurrentPreviously`. Closed
 * slices keep the snapshot evolution wrote at close.
 */
export async function ensurePreviously(
  sliceId: string,
  batch?: WriteBatch
): Promise<string> {
  // Live card — what the current conversation injects. Normalize a legacy
  // (v1/v2/v3) card to the user-card structure once; seed from the latest
  // snapshot or a template when it doesn't exist yet.
  let current = await readCurrentPreviously(batch);
  if (current.trim() && !isCardFormat(current)) {
    current = migrateV3ToCard(current, sliceId);
    await writeCurrentPreviously(current, batch);
  } else if (!current.trim()) {
    const source = await findMostRecentPreviously(batch);
    current = source
      ? isCardFormat(source)
        ? source
        : migrateV3ToCard(source, sliceId)
      : newCardTemplate(sliceId);
    await writeCurrentPreviously(current, batch);
  }

  // Copy the live card to this slice's per-slice file (the agent uses the new
  // slice's card). Only writes when they differ — within a slice the live card
  // is stable, so this is a single fresh write at slice creation, then silent.
  const existing = await readPreviouslyRaw(sliceId, batch);
  if (existing !== current) {
    await writePreviously(sliceId, current, batch);
  }

  return current;
}

// ─── Testing utilities ───────────────────────────────────────────────────

/**
 * Set the active slice directly (useful for testing or hydration).
 */
export function setActiveSlice(slice: TimeSlice | null): void {
  activeSlice = slice;
}

/**
 * Clear the active slice (alias for setActiveSlice(null)).
 */
export function clearActiveSlice(): void {
  activeSlice = null;
}

// ─── Snapshot (intermediate write) ───────────────────────────────────────

/**
 * Save the current in-memory time slice to disk WITHOUT closing it.
 * This is a checkpoint — the slice remains active and turns continue to append.
 * Called every N turns and on beforeunload flush.
 */
export async function saveSliceSnapshot(
  slice: TimeSlice,
  batch?: WriteBatch
): Promise<void> {
  const slicePath = getSlicePath(slice);
  const markdown = serializeSlice(slice);
  await fsWriteFile(slicePath, markdown, batch);
}

/**
 * Persist _index.json and strands.json for an active slice.
 * Called on snapshot save so browseSlices has entries even for active slices.
 */
export async function ensureIndexEntries(
  slice: TimeSlice,
  batch?: WriteBatch
): Promise<void> {
  await updateMonthlyIndex(slice, batch);
  if (slice.tags.length > 0) {
    await updateStrands(slice, batch);
  }
}
