# Architecture

Previously is a cloud agent on Vercel that reads GitHub files, calls LLMs, and streams responses back — no database, no cron, no persistent server. What makes it unusual is that **every chat turn runs inside a durable Vercel Workflow run**: each LLM call and each tool call is an individually durable, auto-retried step. GitHub remains the single source of truth for memory — Workflow is only the execution container.

## The Three Layers

The system is split into three layers, each with a distinct responsibility and a hard boundary between them:

| Layer | What it is | What it does |
|-------|------------|--------------|
| **Browser / Phone** | Next.js App Router UI | Renders the chat surface. Captures input. Streams the response. That is all — no business logic, no state machine, no local memory. |
| **Vercel** | Orchestration | Receives a trigger, reads GitHub state, runs the agent workflow, writes back. Stateless, event-driven, durable. |
| **GitHub Private Repo** | The single source of truth | Holds everything: `src/` (agent-read-only), `memory/`, `tasks/`, `sessions/` (agent-read-write). Code and data coexist in one repo. |

> **Key takeaway: no database, no always-on agent, no persistent connection.** Previously runs entirely inside Vercel's request lifecycle. You send a message, the turn workflow fires, and the response streams back. When the response ends, there is no background process — unless a durable loop is running, and even that persists its state to the repo, not to a server.

## The Durable Turn Workflow

The whole agent is `src/app/api/chat/turn-workflow.ts` — a `"use workflow"` controller. Every user message triggers one of these runs:

1. **Housekeeping** — resolve or recover the active time slice, apply the 30-minute silence rule, append the incoming turn.
2. **Worker pass** — a cheap worker model (derived from the main model's provider) scans recent slice summaries for recall pointers and maintains the slice's metadata, in one call. It also applies the **semantic gate**: trivial turns ("thanks", "continue") produce no tags and no strands.
3. **Prompt assembly** — the system prompt is assembled from identity, the user card, and the episodic timeline context.
4. **Pro agent loop** — the main model runs as a `WorkflowAgent` (`@ai-sdk/workflow`). Each LLM call and each tool call is its own durable step: tool executors are standalone `"use step"` functions in `src/app/api/agent/tool-executors.ts`, so the runtime retries them on transient failures. The agent reasons, recalls, reads, and answers.
5. **Finalize** — the turn is appended, the slice snapshot is saved, indexes and strands are updated.

Because every step is durable, the run survives dropped connections. `WorkflowChatTransport` on the client re-attaches to the same run when the tab returns to the foreground, and replays what was missed. Background loops use the same agent layer as separate workflow runs.

## Agent Layer

The agent layer lives in `src/app/api/agent/` and is shared by chat turns and any background loops:

| File | Purpose |
|------|---------|
| `agent.ts` | Creates the `WorkflowAgent` with the model, thinking, and tool set |
| `tools.ts` | Tool definitions (schema + context schema) — the chat agent's tool set |
| `tool-executors.ts` | Standalone `"use step"` executors for each tool |
| `register-model-classes.ts` | Registers model hosts so they survive the workflow→step boundary |

### Tools

The chat agent gets a small, deliberate tool set. Concept tools (read a slice / belief / cognition you were given an id for):

| Tool | Purpose |
|------|---------|
| `readSlice` | Read a slice's turns, optionally a `range` |
| `readPreviously` | Read the user-card belief snapshot across time |
| `readAgentTimeline` | Read the agent's own past reasoning |
| `listSlices` / `readTimeline` | Explore the timeline (recall-engine job, mostly) |
| `listStrands` / `readStrand` | Follow a keyword across slices |

Delegation tools:

| Tool | Purpose |
|------|---------|
| `recall` | Hands the actual search to the worker model's recall engine, returns pointers |
| `webSearch` / `webFetch` | Look things up on the web |

> **One recall, then stop.** The main agent does not browse memory itself — exploration is the recall engine's job. It asks `recall` once, reads what it needs with `readSlice`, and moves on. `startLoop` is defined but currently commented out (background loops are temporarily disabled while being stabilized).

## Two-Tier Model Split

The model layer (`src/lib/models/`) resolves two tiers:

- **Main model** — user-selected in the chat toolbar, persisted to `memory/user/config.json`. Does the reasoning, tool calling, and response generation.
- **Worker model** — a cheap tier derived from the main model's provider (or manually pinned). Runs the housekeeping calls: recall scanning, metadata maintenance, the semantic gate. This keeps the per-turn cost low while the main model does the heavy lifting.

`resolveWorkerModel()` (`src/lib/models/worker.ts`) picks it: manual pin → same-provider lightweight → the main model. The catalog is models.dev-driven (`src/lib/models/catalog.ts`), gated by configured API-key env vars and reverse-filtered against each provider's live `/models` endpoint.

## Frontend Architecture

The Next.js App Router enforces a strict server-component/client-component boundary. `page.tsx` is a Server Component that preloads the user config and sets up the demo persona, then renders `ChatPage` — a thin client shell owning the AI SDK `useChat` hook with `WorkflowChatTransport`.

The page is one vertical scroller:

1. **Hero** — server-rendered, `"Previously on {name}"`.
2. **Sticky horizontal timeline** — `HorizontalTimeline`, a date-dot strip that snaps below the AppHeader.
3. **Chat content** — live messages, or a historical slice view when a past dot is selected.
4. **Sticky input bar** — with model selector, thinking toggle, image attachments, and the demo trigger.

Message rendering is a unified stream pipeline (`buildStream` in `src/lib/chat/build-stream.ts`): reasoning merges into `ThinkingSteps`, tool calls merge into `ToolRenderer` cards by `toolCallId`, `data-phase` parts become `PhaseIndicator`s, `data-evolution` parts drive the per-bubble `EvolutionIndicator`. Everything renders inline inside the assistant bubble via `AnimatePresence`.

## Core Modules

| Module | Path | Purpose |
|--------|------|---------|
| Capabilities | `src/lib/capabilities.ts` | Global app-mode checks (isAIConfigured, isDemo, canWrite) |
| Episodic Memory | `src/lib/episodic/` | Time-slice management, slicing rules, strands index |
| Turn Analyzer | `src/lib/episodic/flash/turn-analyzer.ts` | The worker-model housekeeping call |
| Time Localization | `src/lib/episodic/time-localize.ts` | Server-side local-time annotation for read tools |
| User Card | `src/lib/episodic/previously-*` | The compact user card + `applyCardUpdate` |
| Model Registry | `src/lib/models/` | models.dev catalog, provider dispatch, worker resolution |
| GitHub Tools | `src/lib/tools/` | readFile/writeFile/listFiles via Octokit |
| Path Whitelist | `src/lib/whitelist/` | Security boundary: memory/tasks/sessions only |

## Security Model

Security is enforced entirely in TypeScript at the tool boundary.

### Path Whitelist

`src/lib/whitelist/index.ts` defines the only three writable directories:

```
memory/   tasks/   sessions/
```

`normalizePath()` decodes URI components, converts backslashes to forward slashes, resolves `./` and `../` segments, and strips leading slashes. `isPathAllowed()` rejects empty paths and absolute paths (Unix and Windows drive letters), then checks the path starts with one of the three allowed prefixes.

### `src/` Is Agent-Read-Only

The `src/` directory simply does not appear in the whitelist. No agent tool can write there. The agent can read `src/` through git, but cannot modify it — the path whitelist rejects write attempts. This keeps the codebase integrity independent of the agent's execution.

### GitHub Token Scope

The `GITHUB_TOKEN` is scoped to a single repository with contents read/write. The agent operates on exactly one repo: the one defined by `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME`. There is no cross-repo access.

All path validation is server-side — the client is untrusted. The browser never constructs file paths or makes storage decisions.

## Data Source Modes

Storage has three modes, controlled by `STORAGE`:

| Mode | When | Behavior |
|------|------|----------|
| `local` | local dev | Reads/writes the local filesystem |
| `github` | production | Reads/writes your repo via the GitHub API (Octokit) |
| `demo` | preview | Read-only, pre-seeded personas |

Auto-detection: `GITHUB_TOKEN` present → `github`; `NODE_ENV=development` → `local`; otherwise → `demo`.

## What Comes Next (Roadmap)

- First-class strands — a rolling summary + recall integration for each strand
- Re-enable background loops (`startLoop` is defined but commented out)
- Richer cross-slice navigation on the timeline
- More demo personas

The project status badge is **experimental**.

## Related

- [Memory Model](/content/docs/en/memory-model) — how slices, strands, and the user card work
- [Recall](/content/docs/en/recall) — the two-tier retrieval pipeline in depth
- [Timeline](/content/docs/en/timeline) — the UI surface and how the agent sees your past
