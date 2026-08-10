# Why Previously

Previously rethinks AI interaction from the ground up: fix the memory model, and the interaction model fixes itself.

## Two Problems, One Root

Current AI assistants share a pair of linked failures that most people experience as one frustration.

**Problem 1: memory is siloed per conversation.** Every new chat starts from zero. The agent cannot see what you discussed yesterday, last week, or in a different thread about an adjacent topic. Cross-conversation recall requires stitching together vector databases, RAG pipelines, and prompt engineering — and even then the result feels like talking to someone with amnesia.

**Problem 2: the conversation list is the wrong cognitive container.** Humans do not organize memories into "Chat #47 with Mom." You remember by *when* something happened and *what* it was about. The flat list of chat threads is a UI artifact inherited from messaging apps, not a model of how people actually think and recall.

These are two faces of the same mistake: building the product around the conversation UI instead of around memory.

## Memory Model Fixes Interaction Model

If an agent genuinely remembers you — across time, across topics, across gaps of days or weeks — then conversation management becomes unnecessary. You do not need to choose or create the right thread. You do not need to remind the agent who you are and what you were doing. You just show up and talk.

Previously replaces the chat-thread list with a **timeline**: a vertical, top-to-bottom view of time slices. Each slice is one uninterrupted conversation burst — opened when you start talking, closed automatically after 30 minutes of silence. The path tells you exactly when it happened:

```
memory/episodic/slices/YYYY/MM/DD/HHMM.md
```

A calendar day is a directory that can hold multiple slices. There are no conversations to name, organize, or search through — just one continuous relationship, scrolled up to revisit the past or down to continue.

Context stays bounded per request because the prompt is assembled from relevant slices on the timeline, not from an ever-growing conversation window. The agent does not forget the start of a long history because the start was never in the window — only the pieces that matter, assembled fresh each time.

> The conversation is a UI artifact. The timeline is a cognitive model.

*The name "Previously" comes from television: "Previously on..." — a brief recap of last time, just enough context to pick up where you left off.*

```preview
demo: slice-file
```

## Design Principles

### A full agent, not just a memory tool

Previously reads, writes, reasons, and acts. Memory is what makes interaction feel continuous, but it is not the only capability. The agent runs tools against your GitHub repository, uses a two-tier model architecture (a cheap worker model for fast recall and metadata maintenance, the main model you pick in the toolbar for deep reasoning and response generation), and operates within a whitelist security boundary that restricts agent writes to `memory/`, `tasks/`, and `sessions/` — the `src/` directory is read-only.

### Memory is the hard problem

Storing conversations is trivial. Retrieving the *right* memory at the *right* moment with the *right* depth is the genuinely hard part — and that is where the effort goes. The architecture reflects this priority: a single worker-model call per request combines recall scanning, the semantic gate, and metadata maintenance. The complexity budget goes to the core store-index-recall loop, not to configuration knobs or edge cases.

### Your memory belongs to you

Memory is plain Markdown with YAML frontmatter, stored in your own GitHub repository. Every file is readable by any tool, portable to any system, and version-controlled through git. There is no cloud database, no vector store, no proprietary format. The storage backend switches between the local filesystem (development) and the GitHub API (production), but the format is identical either way.

The whitelist security layer enforces this ownership. Agent tools can write only to `memory/`, `tasks/`, and `sessions/`. Code — the agent's runtime and capabilities — stays read-only in `src/`.

### Simplicity over sophistication

One slicing rule governs when a conversation burst becomes a new slice: 30 minutes of silence. Earlier iterations had capacity checks and continuity checks; those were removed. A single hard-coded threshold — that is the whole rule. One worker-model call per request handles recall, the semantic gate, and metadata maintenance in a single round-trip, with a retry and a fallback to safe defaults.

Simplicity is a deliberate choice: every configurable knob, every edge-case handler, every stored flag is a tax on future reasoning. Previously pays that tax only where it earns out — in the core loop.

### Human memory is the right metaphor

The architecture maps directly to cognitive science. Endel Tulving's 1972 distinction between **episodic memory** (events tied to a time and place) and **semantic memory** (abstract knowledge, facts, concepts) is the blueprint:

- **Slices** are episodic — "what happened" organized by when.
- **Strands and memory nodes** are semantic — "what it was about." A strand is a keyword woven across every slice that carries it; `memory/episodic/strands.json` maps each strand to its slice paths. (Experimental: strands are written at slice-close but not yet scanned at recall time.)

Recall follows this layered pattern. The **worker model** (the fast, lightweight, intentionally fallible tier) scans recent slice summaries and returns pointers with relevance scores — a quick conditioned reflex. The **main model** receives those pointers and decides which slices to read in full via `readSlice` — deliberate, deep, and resourceful. If the scan finds nothing, the main model explores the slice directory directly.

Context-dependent memory research (Godden & Baddeley, 1975; Smith & Vela, 2001) shows that recall improves when retrieval context matches encoding context. The timeline preserves temporal context, and recall uses it.

```preview
demo: thinking-steps
```

*Two-tier recall is shipped for the live demo at `previously-demo.ldwid.com` (read-only, memory writes disabled, resets on refresh). Richer strand-based recall — scanning `strands.json` actively at query time — is an explicit future milestone.*

## Status

Previously is **experimental**. It is a one-person research project, not yet ready for personal or production use. Everything described here reflects design intent and working code as of v0.7 — features marked as roadmap are actively evolving, not finalized guarantees.

## Related

- [Memory Model](/docs/en/memory-model) — slices, strands, nodes, and the whitelist
- [Recall](/docs/en/recall) — two-tier recall engine
- [Episodic Memory](/docs/en/episodic-memory) — the time-slice system
