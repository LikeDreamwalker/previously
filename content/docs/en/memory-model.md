# Memory Model

Previously eschews databases and vector stores. Memory is plain Markdown files in a git repository — episodic time slices for what happened when, semantic strands and knowledge nodes for what things are — assembled under a token budget at inference time.

## Episodic Memory: The Timeline

Previously records every conversation burst as a **slice**: a single Markdown file on your personal timeline. The path tells you exactly when it happened:

```
memory/episodic/slices/2025/11/21/0825.md
```

A calendar day is a directory that may hold multiple slice files. A slice opens when you start talking, stays active while you stay engaged, and closes automatically after 30 minutes of silence (`src/lib/episodic/slicer.ts`). Read top-to-bottom across months and years, slices are your autobiography — what happened, when it happened, in chronological order.

Every slice carries YAML frontmatter with structured metadata:

```yaml
---
focus: Planning the M8 flash overhaul
summary: Reviewed slicer architecture, decided on time-only slicing
open_loops: [strand integration, demo mode scope]
decisions: [Slice by time only; no topic-based splitting]
tags: [m8, episodic, architecture]
related_slices: [2025/11/20/1430.md]
emotional_tone: focused
status: closed
start: 2025-11-21T08:25:00Z
end: 2025-11-21T09:10:00Z
---
```

Conversation turns are rendered as `## Turn N -- ISO_TIMESTAMP (role)` headers in the Markdown body. This format is managed by the gray-matter library — every git client, every editor, and every LLM can parse it without proprietary tooling.

> **Key takeaway: the timeline is time-driven, not topic-driven.** A slice opens on talk and closes on silence. There is no capacity limit and no topic-shift rule. Your conversation history is lossless and chronological.

```preview
demo: slice-file
```

## Semantic Memory, Layer 1: Strands

A **strand** is a keyword — like `work`, `family`, `health`, `housing` — woven through every slice that carries it. The file `memory/episodic/strands.json` maps each strand to its slice paths:

```json
{
  "strands": {
    "housing": [
      "memory/episodic/slices/2025/03/10/0915.md",
      "memory/episodic/slices/2025/04/02/1400.md",
      "memory/episodic/slices/2025/06/18/1100.md"
    ],
    "work": [
      "memory/episodic/slices/2025/06/18/1100.md",
      "memory/episodic/slices/2025/07/01/0800.md"
    ]
  }
}
```

Strands are built at slice-close via `updateStrands`. A slice = what happened; a strand = what it was about. Strands form the thin, lossless semantic index over the episodic timeline — the whole history of a topic across time, without duplicating the content.

> **Roadmap:** Strands currently carry no rolling summary. A richer first-class strand with its own narrative summary and recall integration is a future milestone.

```preview
demo: strands-index
```

## Semantic Memory, Layer 2: Memory Nodes

**Memory nodes** are separate structured knowledge units at `memory/nodes/`, authored by Previously itself (the main model, via `writeFile`) when a conversation reveals genuinely notable information about you. Unlike strands — which are an auto-built keyword index — nodes are hand- or agent-authored knowledge units with a typed schema:

| Field | Purpose |
|-------|---------|
| `type` | `concept`, `experience`, `project`, `people`, or `personality` |
| `priority` | 1–10, defaults to 5 |
| `domain` | Classification domain, defaults to `general` |
| `tags` | Keyword labels for matching |
| `related` | Links to other node IDs |
| `backlinks` | Reverse links from YAML frontmatter (static) |
| `status` | `active` or `deprecated` |
| `access_count` | Not yet implemented (consumed by scorer but never written) |
| `last_accessed` | Date-only string (YYYY-MM-DD) |
| `superseded_by` | Node ID that replaces this one |

Node relevance is scored at recall time:

```
score = (priority
         + keyword-tag-match[+5 each]
         + graph_bonus[+2 per already-selected linked node]
         + freq_bonus[min(access_count * 0.3, 3)])
         * time_decay

where time_decay = 0.9^(daysSinceAccess / 7)  ~10% decay per week
```

Deprecated nodes always score 0. This scoring feeds the context assembler's selection.

## Layered Memory: L0/L1 vs L2

Memory is organized in three tiers, split by when they load:

| Tier | What | When | Mutable? |
|------|------|------|----------|
| **L0** | Agent constitution (SOUL) | Bundled at build time | Immutable at runtime |
| **L1** | Agent directives (DIRECTIVES) | Bundled at build time | Immutable at runtime |
| **L2** | Episodic slices + strands + nodes | Fetched on demand at runtime | Writable by tools |

L0 and L1 are produced by `scripts/generate-identity.mjs` at build time and compiled into strings. Their source sits outside the tool whitelist — the agent cannot rewrite its own soul. L2 is read live from the filesystem via tools, and that is where the episodic memory, strands, and nodes live.

The user profile (`memory/user/profile.md`) is a hybrid: it loads live from memory/ (L2 at runtime), but the generic `writeFile` tool is blocked from editing it — only a dedicated `updateUserProfile` tool can modify it.

## The Whitelist Boundary

Agent tools are confined to three writable directories (`src/lib/whitelist/index.ts`):

```
memory/   tasks/   sessions/
```

The `src/` directory is agent-**read-only**, never modifiable by any tool. Path validation normalizes inputs — decoding URI components, converting backslashes to forward slashes, resolving `./` and `../`, stripping leading slashes — then rejects empty paths, absolute paths (`/`), and drive-letter paths (`A:`) before matching against the allowed prefixes.

Within the whitelist, certain paths are readable but write-blocked:

- `memory/episodic/` — system-owned slices and indexes
- Any `_index.json` file
- `strands.json`
- `memory/user/profile.md` — editable only via its dedicated tool

This prevents accidental or malicious corruption of the episodic timeline and structural indexes.

## Context Assembly Under a Token Budget

When Previously constructs a prompt, the `src/lib/context/assembler.ts` packs a 5-layer payload under a default budget of 8,000 tokens:

| Layer | Content | Budget Rule |
|-------|---------|-------------|
| 0 | System prompt (constitution + directives) | Full, always included |
| 1 | Core memory nodes (full content) | Capped at budget × 0.7 (reserves 30% for later layers) |
| 2 | Session summary + recent turns | Turns truncated to 300 characters each |
| 3 | Extended nodes (summary only) | First paragraph ≤ 200 characters; stops at budget − 500 |
| 4 | Reference nodes | `[[wikilink]]` titles only |

Token estimation is a heuristic (`ceil(chars / 4)`) — not a real tokenizer. As the budget fills, detail degrades: full node content gives way to summaries, which give way to bare titles. This guarantees every request fits within the model's context window without hard truncation of critical layers.

## Why Plain Markdown + YAML

There is no database, no vector store, and no proprietary format. Every piece of memory is a Markdown file with YAML frontmatter. This choice is deliberate:

- **Portable** — `git clone` anywhere, read on any device, no server needed.
- **Git-diffable** — every change to a slice, node, or strand is tracked in version history. You can see what Previously learned and when.
- **Human-editable** — open any slice in VS Code, fix a summary, add a tag. No admin UI, no SDK.
- **Any tool reads it** — Previously writes, Claude Code reads, Codex extends. No lock-in, no integration tax, no schema migration.

Files are the interface.

## Two-Tier Recall

Recall follows the episodic-then-semantic order grounded in Tulving: scan WHEN first, then retrieve WHAT.

1. **Worker scan** (the resolved worker model) — scans recent slice summaries, returning pointers to relevant slices. Per-round metadata maintenance (tags, strands, summaries) is folded into this single round-trip — the turn analyzer — which retries once after 300ms and falls back to safe defaults.
2. **Main deep read** (the main model) — calls the `readSlice` tool to read full slice bodies for deep recall. This is the expensive, thorough pass that reconstructs context from the raw timeline.

This split keeps fast operations fast while reserving model capacity for the work that needs it.

## Related

- [Architecture Overview](/content/docs/en/architecture)
- [Agent Loop](/content/docs/en/agent-loop)
- [Whitelist & Security](/content/docs/en/security)
