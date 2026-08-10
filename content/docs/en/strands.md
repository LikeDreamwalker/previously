# Strands

A strand is a keyword woven across every time slice that carries it — the semantic layer over the episodic timeline. Where a slice says *what happened* (by time), a strand says *what it was about* (by topic).

## The Problem: Episodic Memory Has No Topic Index

Time slices organize your history chronologically. You can ask "what happened yesterday afternoon" and get the right slice file. But you cannot easily ask "everything I've ever said about Rust" — that question cuts *across* time, not along it.

You need both axes:

| Memory type | Organized by | Unit | Question it answers |
|---|---|---|---|
| **Episodic** | Time | Slice | "What happened when?" |
| **Semantic** | Topic | Strand | "What was said about X?" |

Strands fill the semantic axis. They are the by-topic counterpart to the by-time slice record.

## How It Works

A slice carries `tags` in its YAML frontmatter — keywords like `"rust"`, `"async"`, `"deployment"`. Every time a slice closes, those tags are woven into a single global file:

> `memory/episodic/strands.json`

Each key in that file is a **strand** (one tag). Each value is the list of relative slice paths tagged with that keyword — "the whole history of that thing" across time.

```json
{
  "rust": [
    "2026/06/22/1400",
    "2026/07/01/0915",
    "2026/07/08/1630"
  ],
  "async": [
    "2026/06/22/1400"
  ],
  "deployment": [
    "2026/07/08/1630"
  ]
}
```

The paths are relative: no `slices/` prefix, no `.md` extension. `sliceIdToRelPath` converts a slice id like `2026-06-30-1430` to `2026/06/30/1430` so you can walk directly to `memory/episodic/slices/2026/06/30/1430.md`.

### Live index preview

```preview
demo: strands-index
```

## Derived, Not Authored

Strands have no separate authoring step. They are **derived entirely** from the `tags` array in each slice's YAML frontmatter. Tags are maintained per-round by the worker model as part of its housekeeping update — it reads the conversation, classifies the topic, and writes the tags. Those tags become strands automatically.

The cycle is:

1. **The worker runs metadata maintenance** → writes `tags` into the active slice's frontmatter
2. **The slice is persisted** (either closed after 30 min of silence, or snapshotted mid-conversation)
3. **`updateStrands(slice)` runs** → reads `strands.json`, merges each tag as a key, appends the slice's relative path (deduplicated), writes back

Tags weave into strands. You never write a strand directly.

## When Strands Are Written

`updateStrands` runs in two places:

- **On slice close** (`closeSlice` in `manager.ts`): after the slice `.md` file is written and the monthly `_index.json` is updated, `updateStrands` publishes the slice's tags into the global index.
- **On active-slice snapshots** (`ensureIndexEntries` in `manager.ts`): when a snapshot is saved mid-conversation, `updateStrands` also runs — but only if the slice has at least one tag. This means an in-progress slice appears in the strand index before it closes.

The result: `strands.json` stays current even for active slices, so a recall scan never misses a tag just because the slice hasn't closed yet.

## The Type

The `StrandIndex` type (defined in `src/lib/episodic/types.ts`) is a plain string-keyed map:

```typescript
interface StrandIndex {
  [strand: string]: string[];
}
```

If `strands.json` does not exist yet — no slices have ever had tags — `readStrands()` returns an empty object `{}`. Writing always produces pretty-printed JSON via `JSON.stringify(index, null, 2)`.

## Dual Storage

The read/write path goes through `fsReadFile`/`fsWriteFile` wrappers that transparently target the local filesystem in development or the GitHub API in production. The strand index itself (`strands.json`) is a runtime data artifact — it lives in the same memory repo as the slices, not in the application source tree. Nothing in the working tree of this code repository contains a committed `strands.json`.

## What Strands Are Not (Yet)

As of v0.7 the strand index is **write-only**. It is built and maintained, but no recall code programmatically reads `strands.json` to drive the worker's recall scan. The only path that surfaces strands to the model is a prompt hint added to the main model's context:

> "Use readStrand to explore `memory/episodic/strands.json` if deeper context is needed."

This means the strand index is accurate and up to date, but it is not yet queried automatically. The main model must choose to open the file via the `readStrand` tool. The system trusts the main model to navigate the index, pick relevant strands, and follow their paths to the actual slice files.

A richer **first-class strand** — one with its own rolling summary, its own metadata, and direct integration into the recall pipeline — is an explicit future milestone. The current strand is the thin, lossless index only: the map from keyword to slice paths, nothing more.

## The Only Current Artifact

The only code artifact of topic-based indexing today is a `suggested_topics` field in the worker model's output, which has no downstream consumer. Strands are the sole production semantic index. Topic-based indexing — richer than keyword paths, with its own summaries and metadata — is on the roadmap as a future milestone.

## Related

- [Slices](/content/docs/en/slices) — the episodic counterpart: what happened, by time
- [Timeline](/content/docs/en/timeline) — the vertical view of slices across days and months
- [Recall](/content/docs/en/recall) — how the worker and main model navigate memory
- [Memory Model](/content/docs/en/memory-model) — the three-tier architecture
