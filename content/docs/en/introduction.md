# Introduction

Previously is a lightweight cloud agent whose defining feature is episodic memory: it reads, writes, reasons, and acts, and is designed to never forget across time.

## What Previously Is

Previously is not another assistant you chat with in disposable threads. It is a persistent cloud agent organized around a single idea: **one continuous relationship on one timeline.** You are the commander; Previously is your staff. You show up, you talk, you leave. When you come back — hours, days, or weeks later — the first thing you see is a timeline of your past, not a list of chat threads. The agent figures out relevance by scanning *when* something happened, then retrieving *what* was said.

There are no conversations. There is no conversation management. There is one timeline.

## The "Previously on..." Metaphor

The name comes from television: before a new episode, a brief recap reminds you what happened last time — just enough context to resume. Previously does the same thing. Every time you return, it recaps your own timeline, pulling forward what matters so you never start cold.

> **Key takeaway: Previously replaces the chat-thread model with time slices, so memory and interaction are unified. Fix the memory model and you remove the need to manage conversations at all.**

## How It Differs from Chat-Thread Agents

Mainstream agents split your life into chat threads. Each thread starts cold. Memory across threads is siloed, fragile, and lossy — bolting on vector databases, RAG pipelines, and prompt hacking to approximate what should be a native capability.

Previously replaces threads with **time slices**. Because interaction history and memory share the same structure — a chronological sequence of slices — cross-session recall is a property of the system, not a retrofit. The agent never abruptly forgets the start of a long exchange because context is assembled dynamically per request rather than accumulated in a growing prompt window. Per-request load stays bounded and relevant.

## Vocabulary Tour

Three terms carry the architecture.

**Slice** — One conversation burst. A single Markdown file on the timeline at `memory/episodic/slices/YYYY/MM/DD/HHMM.md`. Opens when you start talking, stays active while you stay engaged, closes automatically after 30 minutes of silence. Carries structured YAML frontmatter: focus, summary, decisions, open loops, tags, emotional tone. Slice = *what happened, and when.*

```preview
demo: slice-file
```

**Strand** — A keyword (like `health`, `work`, `housing`) that recurs across slices. The index `memory/episodic/strands.json` maps each keyword to every slice path that carries it. Strands are built at slice-close from the slice's tags. A slice = what happened; a strand = what it was about. Strands form the thin, lossless semantic layer over the timeline.

**Recall** — The two-tier retrieval engine. A **worker** model (a cheap tier derived from the main model's provider) scans recent closed-slice summaries in a single fast round-trip, returning up to five pointers with relevance scores. It handles the semantic gate and metadata maintenance in the same call. The **main model** (the one you pick in the toolbar, thinking enabled) receives those pointers and reads the full slices via the `readSlice` tool — the expensive, thorough pass. The worker is expected to be imperfect; the main model does the deeper work when the scan returns nothing.

| Term | Layer | Role | Speed |
|------|-------|------|-------|
| Slice | Episodic (when) | Records what happened | Storage, not retrieval |
| Strand | Semantic (what) | Keywords across slices | Built at slice-close |
| Worker recall | Retrieval tier 1 | Scan + pointers + maintenance | ~500 ms (typical) |
| Main recall | Retrieval tier 2 | Deep read + reasoning | Seconds (per tool call) |

## Research Grounding

The episodic / semantic split is not arbitrary. It is grounded in Endel Tulving's episodic vs. semantic memory theory (1972) and context-dependent memory research (Godden & Baddeley 1975; Smith & Vela 2001). Slices encode the *when* (episodic). Strands and memory nodes encode the *what* (semantic). Recall follows the same order: scan when first, then retrieve what.

## Status

Previously is **EXPERIMENTAL** — early development, not yet ready for personal or production use. It is a one-person research project, but intended to be maintained long-term. What works today: streaming chat with visible thinking, recall, and tool calls; time-slice storage with automatic 30-minute-silence slicing; a two-tier recall pipeline (worker scan + main-model deep read); a compact user card that evolves once per closed slice; server-side local-time annotation; a semantic gate that keeps trivial turns out of memory; GitHub file tools with a path whitelist; multi-provider model support (DeepSeek, Anthropic, OpenAI-compatible); durable background runs via Vercel Workflow; and English-plus-Chinese internationalization.

The strand index is built at slice-close and the main model can read it on demand, but the worker scan still searches recent slice summaries first. A first-class strand with its own rolling summary and recall integration is a future milestone.

## Related

- [Memory Model](/content/docs/en/memory-model)
- [Architecture Overview](/content/docs/en/architecture)
- [Agent Loop](/content/docs/en/agent-loop)
