# Slices

Every conversation is a timeline of slices — one burst of back-and-forth, one Markdown file.

## What a slice is

A **slice** is the storage unit of episodic memory: a single conversation session captured as a `.md` file with YAML frontmatter. It is the L2 memory layer — L0 and L1 are baked into the build, L2 (slices) is fetched on demand at runtime. No database, no binary format. Plain Markdown in your repo.

Each slice holds a contiguous burst of turns — the messages you and Previously exchanged in one sitting — alongside metadata maintained by the **worker model** (the cheap housekeeping call that keeps metadata fresh after every turn).

## Lifecycle

A slice has three states: **open**, **active**, and **closed**.

| Phase | What happens |
|-------|-------------|
| **Open** | The chat route calls `createSlice()` when you send a message and no slice is active. Derives the `slice_id` from the current UTC time, seeds the first user turn, and holds the slice in memory. Nothing is written to disk yet. |
| **Extend** | Each subsequent message calls `appendTurn()` — the turn is pushed onto the in-memory slice. The slice stays in memory across the session. Periodically (every N turns and on `beforeunload`) a checkpoint snapshot is written to disk via `saveSliceSnapshot()`. |
| **Close** | After **30 minutes of silence** the slicer triggers. `closeSlice()` marks the slice `status: "closed"`, sets the `end` timestamp, writes the full `.md` to disk, updates the monthly index (`_index.json`), and weaves the slice's tags into the strand index (`strands.json`). The next message opens a fresh slice. |

> **One rule, no exceptions.** The sole slicing trigger is time silence — 30 minutes (`TIME_SILENCE_THRESHOLD_MS = 1,800,000 ms`) since the last turn. Capacity checks and worker continuity heuristics were prototyped and removed as premature optimization in M8. They are never emitted.

On page refresh, `tryLoadTodaySlice()` scans today's directory, finds the most recent `.md` still marked `active`, and re-hydrates it — you pick up where you left off.

## Directory layout

Slices live under `memory/episodic/slices/` in a three-level calendar hierarchy:

```
memory/episodic/
  slices/
    2025/
      11/
        21/
          0825.md     -- one slice
          0930.md     -- another slice, same day
        _index.json   -- monthly index for November 2025
    12/
      ...
  strands.json         -- global keyword-to-slice index
```

A calendar day is a **directory**. A directory can hold multiple slice files — one per `HHMM` burst. Each file is at most one uninterrupted conversation.

> The `HHMM` in the path and in `slice_id` is **UTC** — derived from the first user message's UTC date+time. Your local wall-clock time is stored separately in the `timezone` frontmatter field. This keeps paths stable across time zones and DST shifts.

## YAML frontmatter

Every slice file opens with `---` delimited YAML. These are the fields — everything is written by the worker model at close or during maintenance:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slice_id` | string | yes | `YYYY-MM-DD-HHMM`, UTC datetime of first message |
| `focus` | string | yes | Core topic, one sentence |
| `status` | `"active"` or `"closed"` | yes | Lifecycle phase |
| `start` | string | yes | UTC ISO 8601 timestamp of first turn |
| `end` | string | no | UTC ISO 8601 timestamp of last turn (absent while active) |
| `timezone` | string | yes | User's IANA timezone at time of interaction, e.g. `"Asia/Shanghai"` |
| `summary` | string | yes | Worker-generated recap, 100 characters at most |
| `open_loops` | string[] | yes | Unresolved questions or threads carried forward |
| `decisions` | string[] | yes | Conclusions or action items from this slice |
| `tags` | string[] | yes | Semantic keywords (these weave into the strand index) |
| `related_slices` | string[] | yes | Relative paths of related slices, e.g. `["2026/06/22/1430"]` — may be empty |
| `emotional_tone` | string | no | `"positive"`, `"neutral"`, `"negative"`, or `"mixed"` — assessed by the worker model |

Empty strings and `undefined` fields are stripped from the YAML. Empty arrays (`open_loops: []`) are serialized as-is — they appear as blank lists.

## Turn body

After the frontmatter, each message becomes a level-2 heading:

```
## Turn 1 — 2023-04-21T06:10:00.000Z (user)

Your message text here...

## Turn 2 — 2023-04-21T06:13:00.000Z (agent)

Previously's response...

## Turn 3 — 2023-04-21T06:15:00.000Z (user)

Your follow-up...
```

The format is always `## Turn N — <ISO_TIMESTAMP> (<role>)` with an em dash separator. The `parseTurns()` function reconstructs the array from these headers.

## A real slice file

Here is what a completed slice looks on disk. The `related_slices` field is absent because no related slices were set (the serializer strips empty values, but an explicitly empty array `related_slices: []` would appear; most commonly the field is simply unpopulated).

```preview
demo: slice-file
```

```markdown
---
slice_id: 2023-04-21-0610
focus: Housing project delays and trust crisis management
status: closed
start: "2023-04-21T06:10:00.000Z"
end: "2023-04-21T07:18:00.000Z"
timezone: America/Chicago
summary: Contractor qualification and property deed mismatches stalled
  multiple household files, triggering a community trust crisis...
decisions:
  - Prioritize direct phone calls to affected households before public meetings
  - Use 'real blocker plus specific next step' frame in public communication
open_loops:
  - Whether overall community trust can recover after timeline delays
  - How to balance individual calls and collective meetings under tight resources
tags:
  - work-pressure
  - housing-project
  - trust-crisis
  - community-communication
emotional_tone: mixed
---

## Turn 1 — 2023-04-21T06:10:00.000Z (user)

The housing rehab files that were supposed to close this month are
stalled again. At the public meeting last night residents were angry...

## Turn 2 — 2023-04-21T06:13:00.000Z (agent)

That sounds rough. What specifically broke down — contractor
qualification, property deeds, or something else?
```

Every part of this file is human-readable, git-diffable, and parseable by any tool that handles Markdown and YAML. Gray-matter does the parsing on the Rust/TypeScript side.

## Strands: the semantic index over slices

Each slice carries `tags`. When a slice closes, `updateStrands()` weaves every tag into `memory/episodic/strands.json` — a single file that maps keywords to slice paths:

```json
{
  "work-pressure": [
    "2023/04/21/0610",
    "2023/04/22/0915"
  ],
  "housing-project": [
    "2023/04/21/0610"
  ],
  "trust-crisis": [
    "2023/04/21/0610"
  ]
}
```

A **strand** is one keyword's entry — "the whole history of that thing" across time. It is the thin, lossless semantic-memory layer over episodic slices. Tags aggregate into strands at slice-close; reading strands for recall is a future milestone (experimental).

```preview
demo: strands-index
```

## How slicing works with the worker and main models

The **worker/main split** governs metadata and recall:

- **Worker scan** (the resolved worker model) runs every turn. It maintains the slice's frontmatter — focus, summary, decisions, open loops, tags, emotional tone. It also scans recent closed-slice summaries for recall hits. If the housekeeping call fails, safe defaults apply (intent `"chat"`, no metadata updates).
- **Main deep read** (the main model) performs deep recall by reading full slice bodies via the `readSlice` tool when the worker returns nothing or the question needs richer context.

When a slice closes, the worker freezes the metadata and the slice is sealed on disk.

## Storage backend

The subsystem transparently switches between two backends:

| Environment | Backend | Selection |
|-------------|---------|-----------|
| Development | Local filesystem | `GITHUB_TOKEN` not set |
| Production | GitHub REST API | `GITHUB_TOKEN` present |

All I/O goes through `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in the manager. The same code path works in both environments — no manual switching.

## Indexes maintained at close

When a slice closes, two auxiliary structures update:

1. **Monthly index** (`memory/episodic/slices/YYYY/MM/_index.json`) — a JSON array of slim entries (`SliceIndexEntry`: id, focus, summary, tags, status, start, open_loops, decisions). Enables the timeline UI to browse titles without reading every file.
2. **Strand index** (`strands.json`) — the keyword-to-slice mapping described above. Entries are deduplicated so the same slice never appears twice under the same tag.

## Design rationale

- **Time-only slicing** keeps the system predictable. Capacity thresholds and worker-based continuity heuristics added complexity without proven benefit at this stage — they were removed in M8.
- **In-memory active slice with periodic snapshots** avoids excessive GitHub API writes. The slice lives in a module-level variable, snapshotted every N turns and on `beforeunload`, but never on *every* turn.
- **YAML frontmatter + Markdown body** is the raw material of every documentation ecosystem. It renders in any Markdown viewer, diffs cleanly in git, and parsers exist in every language Gray-matter handles the TypeScript side.
- **Episodic vs. semantic separation** mirrors Endel Tulving's 1972 theory. Slices are episodic (organized by *when*). Strands and memory nodes are semantic (organized by *what*). Recall scans *when* first, then retrieves *what*.

## Related

- [Timeline](/en/docs/timeline) — the horizontal date-dot strip that browses slices by date
- [Strands](/en/docs/strands) — semantic tag index over the slice archive
- [Recall](/en/docs/recall) — how the worker scans and the main model retrieves
- [Memory System](/en/docs/memory-system) — the three-tier architecture
