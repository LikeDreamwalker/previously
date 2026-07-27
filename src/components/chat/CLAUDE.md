# Chat Rendering System

## Overview

The chat rendering system is a client-side component tree that pipes Vercel AI SDK `UIMessage` parts (text, reasoning, tool-invocations, data-phase, data-evolution) through a unified stream pipeline — recall context, reasoning, tool calls, and final response — all rendered inline inside each assistant message bubble via `AnimatePresence`. The top-level container (`ChatPage`) uses `useChat` with `@ai-sdk/workflow`'s `WorkflowChatTransport` — every turn runs inside a durable Vercel Workflow run and is resumable after a dropped connection.

The timeline is a horizontally-scrollable date strip (sticky below AppHeader). Switching between "now" (live chat) and past slices (historical view) swaps the content area without unmounting the timeline.

## Component Tree

```
ChatPage (chat-page.tsx)  ← "use client", top-level useChat container
├── [Hero Section] (children from [locale]/page.tsx — server component)
├── HorizontalTimeline (sticky below AppHeader, horizontally scrollable date dots)
├── Content area (min-h-screen fill)
│   ├── [Live — "now" selected]
│   │   ├── NowPlaceholder (when no messages and not loading — animated gap + "现在")
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
| `horizontal-timeline.tsx` | Horizontally scrollable date/time dot strip with "load more" pagination, selected/highlighted states |
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

- **Unified stream in AnimatePresence**: All inline parts (reasoning, tool, phase, text) render inside a single `AnimatePresence` block within the assistant bubble. Items animate in/out naturally as they arrive. `buildStream()` merges consecutive items of the same type (reasoning deltas, tool parts by callId) to prevent unnecessary remounts.
- **EvolutionIndicator per bubble**: Self-evolution status is per-turn, not global. It renders at the top of the latest assistant bubble using the same `PhaseIndicator` component as thinking/recall/phase indicators, maintaining visual consistency.
- **PhaseIndicator as the universal indicator**: Instead of duplicating expandable card patterns, thinking, evolution, recall, and data-phase items all use PhaseIndicator (not ToolLayout which is for tool calls). This avoids the confusion between indicators and tools.
- **ChatPage owns the orchestration, ChatSection owns the message list, ChatMessage owns the rendering**: Three-layer separation keeps concerns isolated.
- **Timeline as sticky strip**: Horizontally scrollable date dots (newest on the right) snap below the AppHeader. Switching between "now" and past slices swaps the content area via `selectedSliceId` state.
- **NowPlaceholder fills the void**: When no messages exist and the user hasn't sent anything, an animated "现在" placeholder with a computed time gap from the last slice fills the content area.
- **ChatInput owns its images** via `useImageAttachments` hook: paste, drag-drop, and file picker all funnel into the same state. Images are previewed as thumbnails with remove buttons.
- **MarkdownRenderer is not `prose`-only**: it has custom per-element styles (tables with borders, links as blue with underline, code blocks with background, etc.) instead of relying solely on Tailwind typography prose classes.
