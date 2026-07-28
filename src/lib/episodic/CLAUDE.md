# Episodic Memory Subsystem

## Overview

The episodic memory subsystem records, indexes, and recalls conversation history as discrete **time slices** -- one per real conversation session (closed by context loss, 30 minutes of inactivity, or turn cap), stored as Markdown files with YAML frontmatter. A calendar day is a *directory* that may hold multiple slice files. It is the L2 memory layer in Previously On's three-tier memory architecture (L0/L1 bundled at build time, L2 fetched on-demand at runtime).

Flash (deepseek-v4-flash) handles tag extraction and recall search. Pro (deepseek-v4-pro) handles belief evolution (previously.md) and user-facing chat. The core agent (Pro) only reads memory; writes to tags/strands happen mechanically in the housekeeping step.

File storage is abstracted behind a local-filesystem vs. GitHub API switch, gated on `GITHUB_TOKEN`. All paths are under `memory/episodic/`.

## File Map

| File | Role |
|------|------|
| `types.ts` | All type definitions: `TimeSlice`, `Turn`, `SliceFrontmatter`, `SlicingSignal`, `EmotionalTone`, `SliceIndexEntry`, `MonthlyIndex`, `StrandIndex` |
| `index.ts` | Barrel export -- re-exports from `manager.ts` and `slicer.ts` |
| `manager.ts` | Core CRUD: in-memory active slice, path helpers, gray-matter serialization/parsing, turn append, snapshot saves, monthly index and tag index maintenance, previously.md I/O |
| `slicer.ts` | Slicing decision engine — time silence (30 min) |
| `maintenance.ts` | Deprecated v1 module — retained as a stub. Flash calls now live in `flash/recall.ts`, `flash/previously-agent.ts`, and the `extractFlashTags` helper in `steps.ts`. |
| `actions.ts` | Server actions (`"use server"`) for UI consumption: `getEpisodicState`, `getMoreSlices`, `getSliceContent`. Drives the episodic sidebar panel. |
| `turn-parser.ts` | Pure functions to parse core.md into frontmatter + parsed turns, apply range filters, reassemble filtered slices |
| `flash/recall.ts` | Flash recall mini-agent — searches past conversations and returns structured pointers |
| `flash/global-timeline.ts` | Global timeline file aggregating all slice summaries |
| `flash/previously-agent.ts` | Previously Agent (Pro model) — maintains the belief system (previously.md) |
| `previously-format.ts` | v2 long/short-term previously.md format definition, serialization, parsing, validation, v1-to-v2 migration |
| `previously-updater.ts` | Pure functions to apply PreviouslyAgent mutations to previously.md (7 action types) |
| `io-helpers.ts` | I/O wrappers delegating to demo-fs, GitHub API, or local FS |

## Key Flows

### 1. Time slice lifecycle

1. **Create** — `createSlice()` in `manager.ts` is called when the chat route receives a message with no active slice (or after context loss/close). Derives `slice_id` from the UTC date+time of the first message (e.g. `2026-07-07-1558`), creates an in-memory `TimeSlice` with the first turn.
2. **Extend** — `appendTurn()` adds subsequent turns to the in-memory slice. `saveSliceSnapshot()` writes the slice to disk as a checkpoint every N turns and on `beforeunload`.
3. **Close** — Triggered by: context loss (page refresh / device switch), 30-minute time silence, or turn count cap. `closeSlice()` sets `status: "closed"`, writes the MD file, updates `_index.json` and `strands.json`. The cycle repeats with a new slice.
4. **Recover** — `tryLoadTodaySlice()` scans today's directory (`slices/YYYY/MM/DD/`) and re-hydrates the most recent slice still marked `active` on page refresh.

### 2. Flash tag extraction (per turn, in housekeeping)

1. `housekeeping` step calls Flash (thinking disabled) with the user message and existing strand names.
2. Flash returns 0-5 keyword tags via structured tool output. Existing tags are preferred to encourage reuse across languages.
3. Tags are written to `slice.tags` and woven into `strands.json` via `updateStrands()` during the snapshot save.

### 3. Episodic state for the UI

1. `getEpisodicState()` (server action in `actions.ts`) scans monthly indices backward, returns the most recent slice as `active` plus up to 2 more as `recent`, plus a `hasMore` flag for pagination.
2. `getMoreSlices(before)` returns slices older than the given cursor, with cursor-based pagination.
3. `getSliceContent(sliceId)` reads the full MD file, parses turns, and returns structured content for the detail view.

### 4. Belief evolution (async, per turn)

1. The evolution workflow fires in parallel with the chat turn.
2. `readEvolutionContext` reads the current slice's previously.md and agent.md (full content), plus the last 3 turns (incremental).
3. The Previously Agent (Pro, thinking off) does a quick scan first — if nothing warrants changes, it reports empty mutations immediately without calling tools.
4. If mutations are produced, they're applied via `applyPreviouslyAgentOutput()` and written back.

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
            previously.md       -- belief system snapshot (Pro evolution)
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
- **Core agent reads only**: The Pro agent never modifies previously.md or makes judgmental writes. Mechanical writes (slice tags, strands) happen in housekeeping and finalizeTurn. Belief evolution is a separate async workflow.
- **Time-based slicing with context-loss trigger**: The primary slicing triggers are context loss and 30 minutes of inactivity (`"time_silence"`). Turn count cap is a safety net (`"capacity"`).
- **In-memory active slice with periodic snapshots**: The slice is held in a module-level variable. It is snapshotted to disk periodically (every N turns, `beforeunload`) but not on every turn -- avoids excessive GitHub API writes. `tryLoadTodaySlice()` recovers state on refresh.
- **Gray-matter serialization**: Slices use `---` YAML frontmatter + markdown body, parsed via `gray-matter`. Turn headers follow the convention `## Turn {id} — ISO_TIMESTAMP (role)`.
- **Dual storage backend**: Local filesystem (dev) vs. GitHub API (production) selected at import time via a `USE_GITHUB` flag. The `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in `io-helpers.ts` delegate transparently.
- **DEMO_MODE extends scan range**: `actions.ts` checks `DEMO_MODE=true` to scan up to 48 months back instead of 1-2, supporting pre-seeded demo personas.

## Known Limitations

- **`parseSlice()` hardcodes `closedBy: "user_explicit"`** for any slice parsed from disk with `status: "closed"`, ignoring the actual signal that closed it. The signal is lost on serialization — only relevant for historical slices.
- **Rich first-class strands** (with per-strand rolling summaries) are a future milestone. Currently strands are a keyword-to-slice-paths index; the recall agent traces them automatically but they don't yet carry their own semantic summaries.
