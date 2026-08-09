# The Timeline

The timeline is the primary interaction surface of Previously — a single vertical scroll of your conversation history, read top-to-bottom, with the live chat at the bottom edge and the past behind you when you scroll up.

## Not a Chat List, Not a Search Bar

The timeline is the explicit alternative to two dominant UI patterns that most AI chat products adopt. It is **not** a list of conversation threads that you must manually manage, rename, delete, and search through. It is **not** a search bar where you type keywords hoping the right memory surfaces. Both of these patterns impose overhead on the human — they assume you will curate your own memory.

Previously rejects that assumption. Instead, it presents a single vertical timeline — your story as an autobiography, oldest at the top, newest at the bottom, with the live conversation happening at the very bottom edge.

> **Key takeaway: you do not manage conversations. You scroll through your life.**

## Four Regions, One Scroller

The page is a single vertically stacked scroll surface with four regions in order:

1. **Full-screen hero** — `"Previously on {your name}"`, rendered with a cinematic text-reveal. In demo mode this becomes a persona picker instead of your name.
2. **Sticky horizontal timeline** — a compact strip of date dots that snaps below the fixed AppHeader. Each dot is a slice; the newest sits on the right, ending in a "now" node. Scroll the strip horizontally, or use the wheel to move it. It stays put while the content below scrolls, so you can jump to any point in your past from anywhere.
3. **Chat content** — the live conversation when "now" is selected, or a historical slice view when you pick a past dot.
4. **Sticky input bar** — pinned to the bottom of the screen.

Scroll up to revisit the past. Scroll down to continue where you left off.

```preview
demo: slice-file
```

## The Now Marker

At the boundary between recorded past and live present, a large animated **"Now"** word marks the handoff (i18n key `timeline.panel.now`). Rendered with `TextGenerateEffect` at `text-5xl sm:text-6xl`, light weight, centered. This is the terminal point of the timeline: it runs down and hands off here to the live chat below.

## Time-Gap Title Cards (Cold Open)

When you return to Previously after an absence and the chat is still empty, a cinematic gap title-card appears above the Now marker — a label that cuts forward from the last recorded moment to the present.

The gap is computed by `getGapInfo` (chat-page.tsx), which buckets the elapsed time between the last slice's `start` and `Date.now()`:

| Elapsed | Renders as |
|---------|------------|
| < 5 minutes | "Moments later" |
| 1–59 minutes | "{N} minute(s) later" |
| 1–23 hours | "{N} hour(s) later" |
| 1–6 days | "{N} day(s) later" |
| 1–4 weeks | "{N} week(s) later" |
| ≥ 5 weeks | "{N} month(s) later" |

The gap is computed after mount only (inside a `useEffect`) to avoid SSR/hydration mismatch on the wall clock. It is shown only when the live chat has no messages yet; once you speak, the gap card disappears. The i18n labels live in `timeline.gap.*` in `messages/{en,zh}.json`, with correct ICU pluralisation.

## The Horizontal Strip

The timeline is now a **horizontal** date strip (`HorizontalTimeline` in `src/components/chat/`), replacing the older vertical date-grouped panel. Key behaviors:

- **Dot = slice** — each slice renders a date label, a small dot, and a time label. The selected dot is brand-colored and scaled up.
- **Now node** — the rightmost node marks the present. Selecting it returns you to the live chat.
- **Load earlier** — a chevron on the left paginates older slices (10 at a time) when more exist.
- **Wheel-to-scroll** — vertical wheel input is translated into horizontal scrolling.
- **Sticky** — the strip is `position: sticky` below the AppHeader (`top-12`), so it survives content scrolling.

## Historical Slice View

Selecting a past dot swaps the content area into a historical view while the timeline stays mounted:

- **Previously On bar** — a Brain icon + "Previously On" label; clicking it opens a dialog with the slice's `previously.md` (the agent's compact user card).
- **History turns** — the slice's user/assistant exchanges with timestamps, each turn's agent thoughts available through a "Thoughts" popover.
- **Open loops / decisions footer** — the slice's open loops and decisions as labeled pills.

## Slice Rows and Pagination

Each slice is one conversation burst stored as a Markdown file at:

```
memory/episodic/slices/YYYY/MM/DD/HHMM.md
```

The path encodes the full timestamp: year/month/day/hour-minute. A calendar day is a directory that may hold multiple slices. A slice opens when you start talking and closes automatically after 30 minutes of silence. There is no capacity limit and no topic-shift rule — slicing is purely time-driven.

Each slice carries YAML frontmatter with structured metadata (`focus`, `summary`, `open_loops`, `decisions`, `tags`, `emotional_tone`, `status`, `start`/`end` timestamps), making it machine-readable without proprietary tooling.

## The Agent's Episodic Context

When the turn runs, the workflow assembles the system prompt from the timeline — the current slice under "Now — Current Session" and any recall hits bucketed by age (Today / This Week, This Month, A Few Months Ago, Last Year, Earlier), relevance-sorted and capped. This is Markdown **injected into the model's context**, not rendered on screen. Recall is handled by the two-tier system: a worker model scans summaries and returns pointers; the main model reads the full slices that matter via `readSlice`.

```preview
demo: strands-index
```

## Two Distinct Time-Grouped Systems

There are two separate time-grouping systems in Previously that serve different audiences. Do not conflate them.

### 1. Visible UI (for you)

The on-screen timeline is the horizontal dot strip described above — what you see on the page.

### 2. LLM Episodic Context (for the agent)

When the turn assembles the system prompt, it builds a `## Episodic Memory Timeline` section with the current slice and any recall hits. This is the agent's view of your timeline — bucketed by age, relevance-sorted, capped at `MAX_RECALL_HITS`.

## Data Flow

The timeline is populated through server actions:

1. **Initial load** — `getEpisodicState()` returns the most recent slice as `active`, an array of `recent` slices (with summaries and metadata), and a `hasMore` boolean.
2. **Pagination** — `getMoreSlices(before: ISO timestamp, limit: 10)` fetches older slices.
3. **Slice content** — `getSliceContent(slice_id)` lazily loads a slice's full body on selection, with an in-memory cache so revisits are instant.

## Related

- [Memory Model](/content/docs/en/memory-model) — how slices fit into the full episodic + semantic memory architecture
- [Recall](/content/docs/en/recall) — how the worker and main models use the timeline for context retrieval
- [Architecture](/content/docs/en/architecture) — the component tree that renders the timeline alongside live messages
