# Episodic Memory Subsystem

## Overview

The episodic memory subsystem records, indexes, and recalls conversation history as discrete **time slices** -- one per real conversation session (closed by context loss, 30 minutes of inactivity, or turn cap), stored as Markdown files with YAML frontmatter. A calendar day is a *directory* that may hold multiple slice files. It is the L2 memory layer in Previously On's three-tier memory architecture (L0/L1 bundled at build time, L2 fetched on-demand at runtime).

The resolved WORKER model (see `src/lib/models/worker.ts` — a cheap tier derived from the main model's provider, configurable in config.json) runs the internal calls: recall search, the unified turn analyze (tag extraction + semantic hint + intent + slice marking), and belief evolution. The main model handles user-facing chat. The core agent only reads memory; writes to tags/strands happen mechanically in the housekeeping step.

File storage is abstracted behind a local-filesystem vs. GitHub API switch, gated on `GITHUB_TOKEN`. All paths are under `memory/episodic/`.

## File Map

| File | Role |
|------|------|
| `types.ts` | All type definitions: `TimeSlice`, `Turn`, `SliceFrontmatter`, `SlicingSignal`, `EmotionalTone`, `SliceIndexEntry`, `MonthlyIndex`, `StrandIndex` |
| `index.ts` | Barrel export -- re-exports from `manager.ts` and `slicer.ts` |
| `manager.ts` | Core CRUD: in-memory active slice, path helpers, gray-matter serialization/parsing, turn append, snapshot saves, monthly index and tag index maintenance, previously.md I/O |
| `slicer.ts` | Slicing decision engine — time silence (30 min) |
| `maintenance.ts` | Deprecated v1 module — retained as a stub. Worker-model calls now live in `flash/recall.ts`, `flash/previously-agent.ts`, and `flash/turn-analyzer.ts`. |
| `actions.ts` | Server actions (`"use server"`) for UI consumption: `getEpisodicState`, `getMoreSlices`, `getSliceContent`. Drives the episodic sidebar panel. |
| `turn-parser.ts` | Pure functions to parse core.md into frontmatter + parsed turns, apply range filters, reassemble filtered slices |
| `flash/recall.ts` | Worker-model recall mini-agent — searches past conversations and returns structured pointers |
| `flash/turn-analyzer.ts` | The one housekeeping worker-model call: message tags + semantic hint + intent + (on close) slice marking |
| `flash/global-timeline.ts` | Global timeline file aggregating all slice summaries |
| `flash/previously-agent.ts` | Previously Agent (worker model) — rewrites the user card IN PLACE (outputs the full `updated_card`) |
| `previously-format.ts` | previously.md format — v3 archive (read-only history) + v4 user card (Identity/Profile/Recent/Self-model); serialization, parsing, validation, legacy migration |
| `previously-updater.ts` | `applyCardUpdate` — validates + mechanically enforces the agent's updated card (7-day recent expiry, section caps, anti-conflict backstop) |
| `io-helpers.ts` | I/O wrappers delegating to demo-fs, GitHub API, or local FS |

## Key Flows

### 1. Time slice lifecycle

1. **Create** — `createSlice()` in `manager.ts` is called when the chat route receives a message with no active slice (or after context loss/close). Derives `slice_id` from the UTC date+time of the first message (e.g. `2026-07-07-1558`), creates an in-memory `TimeSlice` with the first turn.
2. **Extend** — `appendTurn()` adds subsequent turns to the in-memory slice. `saveSliceSnapshot()` writes the slice to disk as a checkpoint every N turns and on `beforeunload`.
3. **Close** — Triggered by: context loss (page refresh / device switch), 30-minute time silence, or turn count cap. `closeSlice()` sets `status: "closed"`, writes the MD file, updates `_index.json` and `strands.json`. The cycle repeats with a new slice.
4. **Recover** — `tryLoadTodaySlice()` scans today's directory (`slices/YYYY/MM/DD/`) and re-hydrates the most recent slice still marked `active` on page refresh.

### 2. Turn analyze (per turn, in housekeeping)

1. `housekeeping` first decides the slice lifecycle (pure — continue / close / create), then calls `analyzeTurn` (worker model, thinking disabled) ONCE with the user message + existing strand names + (when closing) the closing slice's turns.
2. The call returns: 0-5 message tags (reusing existing tags across languages), a semantic hint (which existing strands the message relates to), the user's intent, and — only when a slice is closing — its `focus` / `summary` / refined `tags` / `emotional_tone`.
3. The close marking is applied to the closing slice BEFORE `closeSlice` persists it, so the timeline and monthly index carry real descriptions.
4. Message tags are written to `slice.tags` and woven into `strands.json` via `updateStrands()` during the snapshot save.

### 3. Episodic state for the UI

1. `getEpisodicState()` (server action in `actions.ts`) scans monthly indices backward, returns the most recent slice as `active` plus up to 2 more as `recent`, plus a `hasMore` flag for pagination.
2. `getMoreSlices(before)` returns slices older than the given cursor, with cursor-based pagination.
3. `getSliceContent(sliceId)` reads the full MD file, parses turns, and returns structured content for the detail view.

### 4. Belief evolution (once per closed slice + explicit trigger)

1. The evolution runs INLINE in the housekeeping step (v0.7b) — synchronously on a slice close and on an explicit user request (detected by `analyzeTurn`'s `memory_update`). Progress streams via `data-evolution` chunks; the result is noted for the agent to acknowledge.
2. `readEvolutionContext` reads the TARGET slice's previously.md and agent.md (full content), plus its last 3 turns; on `slice_closed` the closed slice id is passed for a deep review.
3. The Previously Agent (worker, thinking off) edits the user card IN PLACE and returns the full `updated_card`.
4. `applyCardUpdate()` validates the card and enforces the mechanical rules (7-day recent expiry, section caps, anti-conflict backstop), then it is written back.

## Core Types

All defined in `types.ts` unless noted.

| Type | Key Fields |
|------|------------|
| `TimeSlice` | `slice_id`, `focus`, `status` (active/closed), `start`/`end`, `turns: Turn[]`, `estimatedTokens`, `closedBy: SlicingSignal` |
| `Turn` | `timestamp` (ISO 8601), `role` ("user"/"agent"), `content`, optional `turnId` (6-char base64url) |
| `SliceFrontmatter` | The YAML representation of a slice: adds `summary`, `open_loops`, `decisions`, `tags`, `related_slices`, `emotional_tone` |
| `SlicingSignal` | `"time_silence" \| "user_explicit" \| "capacity" \| "context_lost"` |
| `SliceIndexEntry` | Slim version stored in `_index.json`: `id`, `focus`, `summary`, `tags`, `status`, `start`, `open_loops`, `decisions` |
| `SliceSummary` (actions.ts) | Truncated view for UI: `slice_id`, `focus`, `summary`, `start`, `status`, `open_loops`, `decisions` |

## File Layout on Disk

```
memory/episodic/
  slices/
    YYYY/
      MM/
        DD/
          HHMM/
            timeline/
              core.md           -- time slice body (YAML frontmatter + turns)
              agent.md          -- agent cognition log (mechanical extraction)
            previously.md       -- user-card snapshot (worker-model evolution)
        _index.json             -- monthly index of all slices in this month
  strands.json                  -- the strand index: strand (keyword) -> slice paths
  timeline.md                   -- global timeline (all slice summaries)
```

**Strands.** A slice carries `tags` (keywords). A **strand** is a keyword woven
through all the slices that carry it — one entry in `strands.json` maps a strand
to its slice paths, i.e. "the whole history of that thing" across time. It's the
thin, lossless semantic-memory layer over the episodic slices. Tags are extracted
by Flash in the housekeeping step and woven into strands at snapshot time.

## Design Decisions

- **Flash tag extraction in housekeeping**: A quick, non-thinking Flash call extracts tags from each user message. Existing tags are preferred to encourage cross-language semantic merging (e.g., "self-evolution" and "自我进化" reuse the same tag).
- **Context continuity detection**: When a client has no assistant messages in its history but the recovered slice has agent turns, the slice is closed with `"context_lost"` — handling page refreshes and device switches gracefully.
- **Main agent reads only**: The main agent never modifies previously.md. The worker-model Previously Agent rewrites the card; mechanical writes (slice tags, strands) happen in housekeeping and finalizeTurn. Belief evolution is a separate workflow run.
- **Time-based slicing with context-loss trigger**: The primary slicing triggers are context loss and 30 minutes of inactivity (`"time_silence"`). Turn count cap is a safety net (`"capacity"`).
- **In-memory active slice with periodic snapshots**: The slice is held in a module-level variable. It is snapshotted to disk periodically (every N turns, `beforeunload`) but not on every turn -- avoids excessive GitHub API writes. `tryLoadTodaySlice()` recovers state on refresh.
- **Gray-matter serialization**: Slices use `---` YAML frontmatter + markdown body, parsed via `gray-matter`. Turn headers follow the convention `## Turn {id} — ISO_TIMESTAMP (role)`.
- **Dual storage backend**: Local filesystem (dev) vs. GitHub API (production) selected at import time via a `USE_GITHUB` flag. The `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in `io-helpers.ts` delegate transparently.
- **DEMO_MODE extends scan range**: `actions.ts` checks `DEMO_MODE=true` to scan up to 48 months back instead of 1-2, supporting pre-seeded demo personas.

## Known Limitations

- **`parseSlice()` hardcodes `closedBy: "user_explicit"`** for any slice parsed from disk with `status: "closed"`, ignoring the actual signal that closed it. The signal is lost on serialization — only relevant for historical slices.
- **Rich first-class strands** (with per-strand rolling summaries) are a future milestone. Currently strands are a keyword-to-slice-paths index; the recall agent traces them automatically but they don't yet carry their own semantic summaries.
