# Recall

Recall is how Previously retrieves relevant past conversations — a two-tier engine where a cheap worker model returns lightweight pointers, then the main model reads the slices it chooses, all in a single turn.

## The Two-Tier Recall Engine

Episodic memory in Previously is stored as **slices** — Markdown files at paths like `memory/episodic/slices/2025/11/21/0825.md`, one per conversation burst, opened when you talk and closed after 30 minutes of silence. Over weeks and months these accumulate into a deep archive. The challenge: how does the agent find what matters without reading everything every time?

Previously splits the problem into two reflexes:

| Layer | Model | Cost | What it does |
|-------|-------|------|-------------|
| **Worker scan** (conditioned reflex) | The resolved worker model | Cheap, fast | Scans recent slice summaries, returns **pointers** — `{ slice_id, relevance, reason }` — never full content |
| **Main deep read** (deliberate reasoning) | The main model you pick in the toolbar | Slower, thinking enabled | Receives pointers, reads full slices on demand via `readSlice`, explores the directory when the scan finds nothing |

The worker is fallible by design. It trades completeness for speed: it reads summaries, not full bodies. The main model is the safety net — it can dig deeper wherever the pointers lead, or start from scratch and explore the directory tree.

> **Key takeaway**: the worker answers "where to look." The main model answers "what does it mean." Neither replaces the other.

### Step 1: Worker Scan (~500ms observed)

The scan runs **before** the response stream opens. Each user request triggers the `recall` tool (`recallExecute` in `src/app/api/agent/tool-executors.ts`), which calls the worker model in one round-trip. The scan reads recent closed-slice summaries and judges relevance.

The scan returns a structured result with a `hits` array. Each hit is a pointer — a slice id, a relevance score (0–1), and a one-line reason why it matches. The model is prompted to return up to 5.

**The worker does NOT read the strand index** (`strands.json`). The strand index — a keyword-to-slice-paths map built at slice-close — is present on disk, and the main model can reach it via `readStrand` on demand, but the worker scan itself searches recent slice summaries.

> **One recall, then stop.** If the scan finds nothing, that is a definitive answer — there is no past context for that query. The agent is instructed not to call `recall` again for the same topic, and to answer from the conversation and its own knowledge instead.

```preview
demo: thinking-steps
```

The recall phase renders as a collapsible card with a History icon. Collapsed: the query and hit count. Expanded: each hit as a `slice_id` + reason + relevance percentage, an italic reasoning line, and confidence.

### Step 2: Deep Read

The worker's pointer list is injected into the main model's context. The main model decides which slices to open in full by calling the `readSlice` tool. It can also follow strands (`readStrand`), browse the timeline (`readTimeline`, `listSlices`, `listStrands`), or check what it already believes (`readPreviously`).

| Tool | Purpose |
|------|---------|
| `readSlice` | Read a slice's turns, optionally a `range` |
| `readStrand` | Follow a keyword across the slices that carry it |
| `readPreviously` | Read the user-card belief snapshot |
| `readTimeline` / `listSlices` / `listStrands` | Explore the timeline and indexes |

When the worker found hits, the main model receives guidance: "These summaries are usually enough — only read a specific slice if you need a detail they don't carry." When the scan found nothing, the main model is told to explore the directory directly — starting with `strands.json` if it wants a keyword index.

### Step 3: Metadata Maintenance

The same housekeeping pass that runs the scan also proposes metadata updates for the **active slice** — the one currently being written in this conversation. The turn analyzer (`src/lib/episodic/flash/turn-analyzer.ts`) is the single worker-model call inside housekeeping, producing three things in one cheap pass:

- **message_tags** — keyword tags for the current user message (woven into strands)
- **semantic_hint** — which existing strands this message is about, plus why
- **closed_marking** — focus, summary, refined tags, and tone for a slice that is about to close

A **semantic gate** runs alongside: trivial turns ("thanks", "continue") produce no tags, no strands, and no evolution — so one-off noise doesn't pollute the timeline.

## Three-Phase Chat Rendering

A single assistant message renders in three visually distinct phases, split by part type in `ChatMessage`:

```
Reasoning (Brain icon, expandable card, inside bubble)
    |
    v
Recall / tools (History / tool icons, inline cards)
    |
    v
Response (text + inline tool calls in a Bubble)
```

```preview
demo: thinking-steps
```

### 1. Reasoning Phase

When the main model has thinking enabled (default: on, reasoning effort per your toolbar selection), the reasoning streams as `reasoning` parts. The client renders them as `ThinkingSteps` — a `PhaseIndicator` expandable card with a Brain icon.

- **Collapsed summary**: "Thought · Ns" timer
- **Expanded content**: the reasoning markdown

### 2. Recall / Tool Phase

Tool calls render inline as expandable cards via `ToolRenderer`, each with a human-friendly label:

| Tool | You See |
|------|---------|
| `recall` | Recalling "..." |
| `readSlice` | Viewing {date} |
| `readStrand` | Following "..." |
| `readPreviously` | Reading 前情提要… |

Each card has five visual states: **running** (spinner), **completed** (dot), **error** (red), **interrupted** (yellow), **denied** (red). Click to expand and see the full tool output — a CSS `grid-template-rows` transition, no JS height measurement.

### 3. Response Phase

The response body renders inside a `Bubble`. Text flows through `MarkdownRenderer` (react-markdown + remark-gfm + rehype-highlight). Tool calls appear inline in the order the main model invoked them, each wrapped in a per-tool renderer.

## Related

- [Slices](/docs/en/slices) — how slices are created, closed, and indexed
- [Strands](/docs/en/strands) — the semantic keyword index across slices (experimental)
- [Architecture](/docs/en/architecture) — the turn workflow and the full component tree for message rendering
