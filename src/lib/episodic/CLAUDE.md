# Episodic Memory Subsystem

## Overview

The episodic memory subsystem records, indexes, and recalls conversation history as discrete **time slices** -- one per real conversation session (closed after 30 minutes of inactivity), stored as Markdown files with YAML frontmatter. A calendar day is a *directory* that may hold multiple slice files. It is the L2 memory layer in Previously On's three-tier memory architecture (L0/L1 bundled at build time, L2 fetched on-demand at runtime).

The subsystem is designed around a **Flash/Pro split**: Flash (a fast, fallible DeepSeek call) handles slicing decisions, intent classification, and metadata maintenance in one round-trip per request. Pro (the main agent) performs deeper recall by reading full slice bodies when Flash finds nothing or the query requires richer context.

File storage is abstracted behind a local-filesystem vs. GitHub API switch, gated on `GITHUB_TOKEN`. All paths are under `memory/episodic/`.

## File Map

| File | Role |
|------|------|
| `types.ts` | All type definitions: `TimeSlice`, `Turn`, `SliceFrontmatter`, `SlicingSignal`, `EmotionalTone`, `SliceIndexEntry`, `MonthlyIndex`, `StrandIndex` |
| `index.ts` | Barrel export -- re-exports from `manager.ts` and `slicer.ts` |
| `manager.ts` | Core CRUD: in-memory active slice, path helpers, gray-matter serialization/parsing, turn append, snapshot saves, monthly index and tag index maintenance |
| `slicer.ts` | Slicing decision engine -- single rule: time silence after 30 minutes of inactivity |
| `maintenance.ts` | Unified Flash call combining intent classification, recall scanning, and metadata updates in one LLM round-trip (DeepSeek via Vercel AI SDK). Includes retry logic and safe defaults. |
| `actions.ts` | Server actions (`"use server"`) for UI consumption: `getEpisodicState`, `getMoreSlices`, `getSliceContent`. Drives the episodic sidebar panel. |

## Key Flows

### 1. Time slice lifecycle

1. **Create** -- `createSlice()` in `manager.ts` is called when the chat route receives a message with no active slice. Derives `slice_id` from the UTC date+time of the first message (e.g. `2026-07-07-1558`), creates an in-memory `TimeSlice` with the first turn.
2. **Extend** -- `appendTurn()` adds subsequent turns to the in-memory slice. `saveSliceSnapshot()` writes the slice to disk as a checkpoint every N turns and on `beforeunload`.
3. **Close** -- `checkTimeSilence()` in `slicer.ts` checks whether 30 minutes have elapsed since the last turn. When `true`, `closeSlice()` in `manager.ts` sets `status: "closed"`, writes the MD file, updates `_index.json` and `strands.json` (via `updateStrands`). The cycle repeats with a new slice.
4. **Recover** -- `tryLoadTodaySlice()` scans today's directory (`slices/YYYY/MM/DD/`) and re-hydrates the most recent slice still marked `active` on page refresh.

### 2. Unified Flash maintenance (per request)

1. `runUnifiedFlash()` in `maintenance.ts` builds a prompt from current slice metadata, recent turns, the new user message, and recent closed-slice summaries.
2. DeepSeek returns structured output via `flashOutput` tool call: intent classification, recall hits (up to 5 past slices with relevance scores), and metadata updates (focus/summary/decisions/open_loops/tags/tone).
3. On failure, retries once after 300ms, then falls back to safe defaults (`intent: "chat"`, `confidence: 0.3`, no updates).
4. `applyMetadataUpdates()` patches the slice object in place.

### 3. Episodic state for the UI

1. `getEpisodicState()` (server action in `actions.ts`) scans monthly indices backward, returns the most recent slice as `active` plus up to 2 more as `recent`, plus a `hasMore` flag for pagination.
2. `getMoreSlices(before)` returns slices older than the given cursor, with cursor-based pagination.
3. `getSliceContent(sliceId)` reads the full MD file, parses turns, and returns structured content for the detail view.

## Core Types

All defined in `types.ts` unless noted.

| Type | Key Fields |
|------|------------|
| `TimeSlice` | `slice_id`, `focus`, `status` (active/closed), `start`/`end`, `turns: Turn[]`, `estimatedTokens`, `closedBy: SlicingSignal` |
| `Turn` | `timestamp` (ISO 8601), `role` ("user"/"agent"), `content` |
| `SliceFrontmatter` | The YAML representation of a slice: adds `summary`, `open_loops`, `decisions`, `tags`, `related_slices`, `emotional_tone` |
| `SlicingSignal` | `"time_silence" \| "user_explicit" \| "capacity"` |
| `SliceIndexEntry` | Slim version stored in `_index.json`: `id`, `focus`, `summary`, `tags`, `status`, `start`, `open_loops`, `decisions` |
| `MaintenanceOutput` (maintenance.ts) | `intent`, `confidence`, `suggested_topics`, `recall_hits[]`, `needs_metadata_update`, `metadata_updates`, `reasoning` |
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
            previously.md       -- belief system snapshot (Flash/Pro evolution)
        _index.json             -- monthly index of all slices in this month
  strands.json                  -- the strand index: strand (keyword) -> slice paths
  next-previously.md            -- Pro's latest reflection, picked up by next slice
```

**Strands.** A slice carries `tags` (keywords). A **strand** is a keyword woven
through all the slices that carry it — one entry in `strands.json` maps a strand
to its slice paths, i.e. "the whole history of that thing" across time. It's the
thin, lossless semantic-memory layer over the episodic slices (built at
slice-close via `updateStrands`; not yet read for recall). Tags weave into
strands; a richer first-class strand (with its own rolling summary + recall
integration) is a future milestone.

## Design Decisions

- **Flash as a conditioned reflex**: Intent, recall scanning, and metadata maintenance are combined into one LLM call per request layer to keep latency low. Flash is expected to be fallible; Pro does deeper work when Flash returns nothing.
- **Time-only slicing in M8**: Capacity checks and Flash-based continuity analysis were removed as premature optimization. The primary slicing trigger is 30 minutes of inactivity (`"time_silence"`). Turn count cap may also force-close a slice (`"capacity"`).
- **In-memory active slice with periodic snapshots**: The slice is held in a module-level variable. It is snapshotted to disk periodically (every N turns, `beforeunload`) but not on every turn -- avoids excessive GitHub API writes. `tryLoadTodaySlice()` recovers state on refresh.
- **Gray-matter serialization**: Slices use `---` YAML frontmatter + markdown body, parsed via `gray-matter`. Turn headers follow the convention `## Turn N -- ISO_TIMESTAMP (role)`.
- **Dual storage backend**: Local filesystem (dev) vs. GitHub API (production) selected at import time via a `USE_GITHUB` flag. The `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in `manager.ts` delegate transparently.
- **DEMO_MODE extends scan range**: `actions.ts` checks `DEMO_MODE=true` to scan up to 48 months back instead of 1-2, supporting pre-seeded demo personas.

## Known Limitations

- **`parseSlice()` hardcodes `closedBy: "user_explicit"`** for any slice parsed from disk with `status: "closed"`, ignoring the actual signal that closed it. The signal is lost on serialization — only relevant for historical slices.
- **Strand recall** is not yet wired into the agent's recall path. Strands are built at slice-close but only consumed via `readStrand` / `listStrands` tools, not yet integrated into Flash's automatic recall scan.
