# Getting Started

Previously replaces chat threads with a single, continuous relationship organized on a timeline — you just show up and talk, and the agent decides what past context is relevant per message.

## The Interface

A fixed **AppHeader** spans the top of every page: the "Previously" logo on the left, with GitHub, Docs, Settings, theme toggle, and language toggle on the right. Always visible regardless of scroll position.

The page is one vertical scroller in four sections, top to bottom:

1. **Full-screen hero** — `"Previously on {your name}"` rendered in a cinematic text-reveal animation. In demo mode, this becomes a persona picker.
2. **Sticky horizontal timeline** — a compact date-dot strip snapping below the AppHeader. Each dot is a slice; the rightmost node is "now."
3. **Chat content** — the live conversation when "now" is selected, or a historical slice view when you pick a past dot.
4. **Sticky input bar** — pinned to the bottom of the screen.

> **Key takeaway: there is no conversation list, no thread management, no "new chat" button. The timeline IS the conversation list.**

```preview
demo: tool-layout
```

## How Memory Forms as You Talk

Memory is not something you manage — it forms automatically while you talk.

A **slice** is one conversation burst. It opens when you start typing, stays active while you're engaged, and closes after 30 minutes of silence. That's the only rule. No capacity limits, no topic-shift detection, no ML-driven false splits. Pure time-driven slicing.

Every closed slice writes a Markdown file at:

```
memory/episodic/slices/YYYY/MM/DD/HHMM.md
```

The path is the timestamp: year, month, day, and the hour-minute of the first message. The file carries YAML frontmatter — focus, summary, decisions, open loops, emotional tone, and tags — maintained by the agent per turn. You never annotate anything by hand.

Read top to bottom across months and years, the slice directory is your autobiography. Git-diffable, human-readable, portable.

```preview
demo: slice-file
```

## Asking About Your Past: Watching Recall Work

When you ask something that touches the past — "What did I decide about the housing project?" or "Remind me when I last talked to Sarah" — Previously runs a visible two-tier recall that renders as expandable cards above the answer.

1. **Worker scan** (~500 ms, a cheap model) — scans recent slice summaries and the strand index (`memory/episodic/strands.json`). It returns **pointers** to relevant slices: slice IDs, relevance scores, and a reason for each hit. This is the fast, approximate pass. The same housekeeping call maintains the active slice's metadata (summary, tags, open loops) as a side effect.

2. **Main-model deep read** — the main model (the one you picked in the toolbar) receives the pointers and decides which slices to read in full via the `readSlice` tool. The tool call shows as an inline card. If the scan found nothing, the model can explore on its own.

The recall results render as a card with a History icon:

- **Collapsed**: shows the recall query and hit count.
- **Expanded**: shows the scan's reasoning text, a list of recall hits (slice ID, reason, relevance percentage), and confidence.

Tool calls during deep recall render as inline cards with human-friendly labels:

| Tool | You See |
|------|---------|
| `recall` | Recalling "..." |
| `readSlice` | Viewing {date} |
| `readStrand` | Following "..." |
| `readPreviously` | Reading 前情提要… |

Each card has five visual states: **running** (spinner), **completed** (dot), **error** (red), **interrupted** (yellow), **denied** (red). Click or press Enter/Space to expand and see the full tool output — a CSS `grid-template-rows` transition, no JS height measurement.

The message itself renders in three phases, matching the agent's internal execution order: **Reasoning** → **Recall/tools** → **Response**. You see the agent think, scan the timeline, work, and then answer — all in one message.

```preview
demo: thinking-steps
```

## First-Run Experience: Demo Mode

Previously does not have an in-app onboarding wizard. Instead, it ships a read-only **demo mode** that transforms the deployment into a tour.

Run with `STORAGE=demo` (or leave `STORAGE` unset on a server without a `GITHUB_TOKEN`) and every `memory/` read is served from a seeded fictional persona — by default **Caleb**, 30+ slices spanning 2022 to 2025. A fixed badge in the header tells you nothing written is saved. Writes appear to succeed but never hit the repository; refresh the page and the slate resets.

The live demo is at [previously-demo.ldwid.com](https://previously-demo.ldwid.com). It runs the full two-tier recall system, so you can browse the timeline, scroll through past slices, chat freely, and watch recall work — all without setting up your own deployment.

### Starting Your Own Timeline

To move from demo to your own timeline:

1. Deploy Previously with your own GitHub repository and a GitHub personal access token (contents read/write scope).
2. Set `STORAGE=github` (or let auto-detection do it: unset `STORAGE`, set `GITHUB_TOKEN`).
3. That's it. The first message you type opens your first slice.

There is no account creation, no database setup, and no seed data. The timeline starts empty. Memory accumulates from your first conversation forward.

## Strands: The Semantic Layer Over Time

As slices accumulate, the agent builds a lightweight keyword index called **strands**. A strand is a topic keyword — like `work`, `family`, `housing` — that recurs across multiple slices. The file `memory/episodic/strands.json` maps each strand to every slice that carries it.

Recall scans the strand index to find slices by topic, not just by recency. If you've talked about "housing" across 30 slices across three years, the scan finds them through the strand index, then the main model reads the actual content.

```preview
demo: strands-index
```

> **Roadmap:** Strands today are a thin keyword-to-slice index. A richer first-class strand with rolling summaries and deeper recall integration is a future milestone. For now, the index is lossless — it points to every relevant slice, and the main model reads what it needs.

## What This Means Day to Day

There are no rituals. You don't open a "new conversation." You don't tag or classify anything. You don't manage memory.

- **Show up** — open the page. The timeline is there, pre-loaded with your recent past. The hero says "Previously on {your name}."
- **Talk** — type and press Enter. If it's been more than 30 minutes, a new slice opens. The agent reads the timeline, scans for relevant context, and responds.
- **Ask about the past** — "What did I decide about X?" or "When did Y happen?" The worker scans summaries and the strand index, the main model reads the full slices, and you see the tool cards appear and resolve.
- **Scroll** — the sticky timeline above the live chat is your full history. Horizontal dots, with a "now" node at the right edge.

That's the loop. No setup, no cleanup, no thread management. Just one continuous conversation with memory that works.

## Project Status

**Previously is in active early development and not yet ready for personal or production use** (status: experimental). The core architecture is functional, but many subsystems are still being designed and built. This guide documents the current codebase; it is framed as a personal self-hosted deployment, not a SaaS signup.

## Related

- [Memory Model](/content/docs/en/memory-model) — slices, strands, the whitelist, and context assembly
- [Architecture Overview](/content/docs/en/architecture) — three-layer separation, the turn workflow, and the edge deployment model
- [Recall](/content/docs/en/recall) — the two-tier retrieval pipeline in detail
