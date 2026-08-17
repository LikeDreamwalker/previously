# Chat Rendering System

## Overview

The chat rendering system is a client-side component tree that pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-phase, data-evolution) through a unified stream pipeline — recall context, reasoning, tool calls, and final response — all rendered inline inside each assistant message bubble via `AnimatePresence`. The top-level container (`ChatPage`) uses `useChat` with `@ai-sdk/workflow`'s `WorkflowChatTransport` — every turn runs inside a durable Vercel Workflow run and is resumable after a dropped connection.

The timeline is a full-height **wheel** on the left (sticky below AppHeader): a virtual-scrolled column of the real time slices (rendered from `timeline/index.json`), oldest at the top and newest at the bottom. A center selection band highlights the focused slice; a central rolling readout animates the timestamp (digits count down while scrolling into the past, up while forward). Switching between "now" (live chat) and past slices (historical view) swaps the content area without unmounting the wheel.

## Component Tree

```
ChatPage (chat-page.tsx)  ← "use client", top-level useChat container
├── [Hero Section] (children from [locale]/page.tsx — server component)
├── TimelineWheel (sticky left, full-height, virtual-scrolled focal wheel over the slice catalog)
├── Content area (min-h-screen fill)
│   ├── [Live — "now" selected]
│   │   ├── EmptyBriefing (when no messages and not loading — the "Previously On" arrival briefing)
│   │   └── ChatSection (chat-section.tsx)
│   │       ├── ChatMessage (per message)
│   │       │   ├── EvolutionIndicator  ← per-bubble self-evolution status
│   │       │   ├── ThinkingSteps  ← reasoning parts (Brain icon, streaming subtitle)
│   │       │   ├── PhaseIndicator  ← data-phase parts (slicing, etc.)
│   │       │   ├── ToolRenderer  ← dispatches tool-* parts to per-tool renderers
│   │       │   │   ├── RecallToolRenderer   (recall)
│   │       │   │   ├── MemoryToolRenderer   (readSlice / readPreviously / readTimeline / readStrand / readAgentTimeline)
│   │       │   │   ├── ListFilesRenderer    (listSlices / listStrands)
│   │       │   │   ├── WebSearchRenderer    (webSearch)
│   │       │   │   ├── LoopToolRenderer     (startLoop)
│   │       │   │   └── DefaultRenderer      (unknown tools)
│   │       │   └── MarkdownRenderer  ← text parts (react-markdown + GFM + highlight)
│   │       ├── LoadingTip placeholder (before first assistant message arrives)
│   │       └── Error banner
│   │       └── LoopWatcher (side-effects only, renders null)
│   └── [Historical — past slice selected]
│       └── HistoricalChatView
│           ├── Previously On bar (Brain icon + click-to-expand dialog)
│           ├── HistoryTurn list (user/assistant bubbles with timestamps)
│           │   └── CognitionPopover (per-turn "Thoughts" dialog)
│           └── Open Loops / Decisions footer
├── [Fixed bottom bar]
│   └── ChatInput (textarea + image attachments + submit/stop/demo)
```

## Message Part Flow

1. `useChat` (in `ChatPage`) receives a `UIMessage` with typed `parts[]`; `ChatSection` maps them to `ChatMessage`.
2. `ChatMessage.buildStream()` classifies each part in a single pass:
   - `reasoning` → merged consecutively into one `ThinkingSteps` block (streaming mode with typewriter subtitle)
   - `tool-*` → merged by `toolCallId` into a single `ToolRenderer` card (folds input-streaming → input-available → output-available)
   - `data-phase` → merged by phase name (emits `{running: true}` at start, `{running: false}` at end). Rendered as `PhaseIndicator` (static mode, Activity icon)
   - `text` → buffered and flushed into `MarkdownRenderer` blocks
3. Items render in natural stream order inside `AnimatePresence` for enter/exit animations.
4. `EvolutionIndicator` renders at the top of the latest assistant bubble (Brain icon, PhaseIndicator wrapper) — shows self-evolution status per turn.
5. A `LoadingTip` pulses at the bottom while streaming.
6. `MessageActions` (copy/regenerate) render in `MessageFooter` — gated on `onRegenerate` prop.

## File Map

| File | Description |
|------|-------------|
| `chat-page.tsx` | Top-level `"use client"` container: `useChat` hook, `WorkflowChatTransport` wiring, evolution SSE streaming, timeline state, hero/messages/timeline regions, sticky `ChatInput` |
| `chat-section.tsx` | Renders the message list (`ChatMessage` per message), the pre-first-part loading placeholder, and the error banner |
| `chat-message.tsx` | Per-message renderer: unified stream pipeline (`buildStream`) — classifies parts into reasoning/text/tool/phase, wraps in `AnimatePresence` |
| `chat-input.tsx` | Textarea with image attachments (paste/drag-drop/file picker), auto-resize, submit/stop buttons, demo trigger |
| `phase-indicator.tsx` | Reusable expandable header bar: two modes — `streaming` (typewriter subtitle, elapsed timer) and `static` (manual expand, chevron). Used by ThinkingSteps, EvolutionIndicator, RecallToolRenderer, and data-phase items |
| `evolution-indicator.tsx` | Self-evolution status bar per bubble: running/error/complete states, mutation list expansion. Built on PhaseIndicator |
| `thinking.tsx` | Reasoning display: Brain icon, streaming subtitle, elapsed timer, expandable Markdown. Uses PhaseIndicator in streaming mode |
| `tool-renderer.tsx` | Central dispatch hub: maps `toolName` to specific renderers, extracts `ToolRenderState` from raw SDK state |
| `tool-layout.tsx` | Shared expandable tool card: status icon (spinner/dot/error/interrupted), name, summary, meta, CSS grid-animated details panel |
| `tool-renderers/recall.tsx` | Recall tool: History icon, query summary, hit count + confidence, expandable hits list with pointers |
| `tool-renderers/memory-tool.tsx` | Memory read tools (readSlice, readPreviously, readTimeline, readStrand, readAgentTimeline): Search icon, path label, formatted output |
| `tool-renderers/list-files.tsx` | List tools (listSlices, listStrands): folder/file icons, item count |
| `tool-renderers/web-search.tsx` | WebSearch tool: Globe icon, query summary, Markdown answer + source links |
| `tool-renderers/loop.tsx` | StartLoop tool: Repeat icon, goal summary, loopId/filePath details |
| `tool-renderers/default.tsx` | Fallback for unknown tools: Wrench icon, JSON-snippet summary |
| `historical-chat-view.tsx` | Past slice content: Previously On bar (dialog), turn list with timestamps, CognitionPopover per turn, open loops/decisions footer |
| `timeline-wheel.tsx` | ONE self-contained virtual-scrolled focal wheel over the slice catalog. It owns its responsive switch internally (a `useIsMobile()` matchMedia hook) — the parent just renders `<TimelineWheel …/>`, no `narrow`/`compact` props. The spine (one shared brand beam), focal scale, scroll and selection logic are a single code path for both gears; the ONLY responsive part is the per-row `RowTimestamp`: mobile = lock-screen clock (MM/DD over big HH/MM, 96px rows) straddling the centered spine, desktop = axis dot + two-line timestamp right of the left spine (plus selection band + rolling HH:MM readout). Reads `getTimelineCatalog()` |
| `resizable-split.tsx` | The two-pane layout: a content-fitted timeline on the left (width measured live via ResizeObserver) + a right panel that scrolls internally. No drag resize — expanding widens the SAME timeline in place over the content with a blur mask |
| `timeline-overlay-context.tsx` | Shared full-screen-timeline state between the header toggle (AppHeader) and the chat page (provider in the locale layout); locks body scroll while open |
| `time-display.tsx` | The shared time readout (`NumberTicker` per field). With `from`, each field rolls from that time's value to `timestamp`'s (forward/reverse automatically) and `onRollComplete` fires once settled |
| `relative-time.tsx` | The time-travel readout shown during slice navigation: a big relative label (anchored to wall-clock now — "3 days ago", "昨天") as the title + the actual time as a smaller rolling subtitle (rolls from the viewer's current position to the target). The label's count is a `NumberTicker` (monospace, rolls from 0 on entry) |
| `empty-briefing.tsx` | The empty-live "arrival" briefing: a letter-spaced `PREVIOUSLY ON` eyebrow + the user's name over a soft brand glow (film-title-card framing), then a hot-start summary drawn from real memory — the active slice's focus ("上次聊到"), open loops ("还欠着的事"), and contextual suggestion chips ("可以接着聊"). Every section only renders when it has real data; the name doubles as the persona switcher in demo mode; "view full previously" opens the same Previously On dialog the slice view uses |
| `time-display.tsx` | Date/time formatting: `sameDay()` check, `TimeDisplay` with date/time modes |
| `cognition-popover.tsx` | Per-turn agent thoughts dialog: Brain icon trigger, lazy-loaded Markdown content |
| `loading-tip.tsx` | Loading indicator cycling through i18n tips with fade transitions |
| `loop-watcher.tsx` | Side-effect component: watches for completed `startLoop` calls, subscribes to streams (renders null) |
| `markdown.tsx` | Markdown renderer: react-markdown with remark-gfm, rehype-highlight, custom components for code/table/link/list/blockquote |
| `code-block.tsx` | Fenced code block: header bar with language label + copy button, scrollable code area |
| `message-actions.tsx` | Copy-to-clipboard and Regenerate buttons, shown on hover via group-hover opacity |
| `file-name-pill.tsx` | File path badge with code-vs-text icon detection, optional error styling |
| `theme-toggle.tsx` | `ThemeToggle`: toolbar button cycling light → dark → system |
| `locale-toggle.tsx` | `LocaleToggle`: toolbar button swapping UI language (en ⇄ zh) via the URL locale |

## Shared Primitives

- **PhaseIndicator** (`phase-indicator.tsx`): Universal expandable header bar with two modes. Used by ThinkingSteps, EvolutionIndicator, RecallToolRenderer, and data-phase items. Both modes share the same render structure: icon + label + optional summary/meta + CSS-grid-animated expandable card.
- **ToolLayout** (`tool-layout.tsx`): Universal expandable tool card handling five states (running, completed, error, interrupted, denied). Every tool renderer delegates to it.

## Design Decisions

- **Arrival = in-flight work or nothing**: on mount, `ChatPage` asks the server whether the persisted run is still pending/running (`isChatRunActive`) BEFORE `Inner`/`useChat` mount — the server is the only authority on run liveness; the client never infers slice boundaries from timestamps or silence windows. A live run → restore the working conversation + `resume` (the replay rebuilds the trailing partial turn). Anything else → the localStorage stash is CLEARED and the live view opens blank on the arrival briefing. Completed conversation is never resurrected client-side: it belongs to its slice on the timeline, and continuity ("上次聊到" / suggested follow-ups) is the briefing's job. The stash therefore can't accumulate stale turns across refreshes.
- **Unified stream in AnimatePresence**: All inline parts (reasoning, tool, phase, text) render inside a single `AnimatePresence` block within the assistant bubble. Items animate in/out naturally as they arrive. `buildStream()` merges consecutive items of the same type (reasoning deltas, tool parts by callId) to prevent unnecessary remounts.
- **EvolutionIndicator per bubble**: Self-evolution status is per-turn, not global. It renders at the top of the latest assistant bubble using the same `PhaseIndicator` component as thinking/recall/phase indicators, maintaining visual consistency.
- **PhaseIndicator as the universal indicator**: Instead of duplicating expandable card patterns, thinking, evolution, recall, and data-phase items all use PhaseIndicator (not ToolLayout which is for tool calls). This avoids the confusion between indicators and tools.
- **ChatPage owns the orchestration, ChatSection owns the message list, ChatMessage owns the rendering**: Three-layer separation keeps concerns isolated.
- **Timeline as a focal wheel**: A full-height virtual-scrolled column of the slice catalog on the left. The row nearest the vertical center is enlarged (scale + opacity fall off with distance); a center selection band highlights it; the central readout rolls its digits (odometer-style) when the focused slice changes. Scrolling up = into the past (digits count down), down = toward now. **Content loads only on explicit click** — scrolling is pure preview (readout + focus text), so browsing costs zero requests. This matters because slice reads are GitHub API calls in production. **The blue selection mark follows the LOADED slice** (whose content the right side shows), not the scroll preview — it moves only when the user clicks.
- **Timeline is ONE responsive wheel**: `TimelineWheel` is self-contained — it decides its own gear internally via a `useIsMobile()` matchMedia hook (nothing threaded in from the parent). The spine, brand beam, focal scale, scroll and selection logic are one shared code path — the single responsive surface is the per-row `RowTimestamp`: mobile = the lock-screen clock (small MM/DD over big hour and minute digits, 96px rows) straddling the centered spine, each clock acting as its own readout; desktop = the left-axis sidebar (axis dot + two-line timestamp right of the spine, selection band + a central rolling HH:MM readout). `ResizableSplit` wraps it as a content-fitted left panel + internally-scrolling right panel; expanding widens the SAME timeline in place over the content with a blur mask (`timeline-overlay-context`).
- **Mouse drag-to-scroll**: the wheel also responds to left-button drag with a **content-follows-finger** gesture (mobile-style): drag down moves the content down → reveals earlier/past frames; drag up → toward now. `mousedown` calls `preventDefault()` to stop text selection, `select-none` is on the container, and a click-capture handler swallows the click that would otherwise fire when a drag ends over a row.
- **Navigation = time travel**: clicking a slice renders `RelativeTimeReadout` in the content area — the relative label, anchored to wall-clock NOW (yesterday reads "昨天", 3 days ago reads "3天前", wherever the viewer sits) — is the big title (its count is a `NumberTicker` that rolls straight from 0 on entry, monospace like all time rendering), and the actual time is a smaller rolling subtitle. With `from` set, the subtitle's fields roll from where the viewer currently is to the target the moment they enter (no start beat — same as the title count) — `NumberTicker`'s spring is bidirectional, so direction is automatic (reverse when going back, forward when going forward). Pacing: the spring settles (~1s), then a ~1.2s hold at the target (`ROLL_HOLD_MS`) before `onRollComplete` — so the clock visibly lands, pauses, then leaves. Wrapped in `AnimatePresence mode="wait"` for fade in/out; the target content fetches in the background and fades in. Submitting a chat message cancels any in-flight transition.
- **Empty state = the arrival briefing, not a clock**: the empty-live state renders `EmptyBriefing` — a film-title-card `PREVIOUSLY ON` eyebrow + the user's name over a soft brand glow, with a hot-start summary drawn from real memory (the active slice's focus, open loops, and contextual suggestion chips). There is deliberately NO live clock — the product is not an alarm clock. Every section fail-safes: it only renders when its data exists (nothing reads "上次聊到" followed by nothing). The name doubles as the persona switcher in demo mode.
- **Shared stage-light language**: the time-travel transition and the empty briefing share one visual identity — the `PREVIOUSLY ON` mono eyebrow + a soft `brand-500/10` radial glow — so the two "moments" (arriving, and traveling through time) feel like one product.
- **ChatInput owns its images** via `useImageAttachments` hook: paste, drag-drop, and file picker all funnel into the same state. Images are previewed as thumbnails with remove buttons.
- **MarkdownRenderer is not `prose`-only**: it has custom per-element styles (tables with borders, links as blue with underline, code blocks with background, etc.) instead of relying solely on Tailwind typography prose classes.
