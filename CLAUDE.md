# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## About

A Next.js web application where a cloud LLM agent reads and writes repository state through a chat interface. The agent runs server-side, operates only on whitelisted data directories (`memory/`, `tasks/`, `sessions/`), and can spawn durable background loops (Vercel Workflow) that persist their progress to the repo.

Every chat turn itself runs inside a durable Vercel Workflow run (`src/app/api/chat/turn-workflow.ts`), streamed back through `run.readable` and resumable after a dropped connection. The agent loop is AI SDK 7's `WorkflowAgent` (`@ai-sdk/workflow`): chat turns and background loops share one agent layer (`src/app/api/agent/` — factories, tool definitions, and standalone `"use step"` tool executors), so every LLM call and every tool call is an individually durable, auto-retried workflow step. GitHub files remain the single source of truth for memory — Workflow is only the execution container, never a store. There is intentionally no database/KV; cross-device reconnect is deliberately not implemented because it would require one.

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Vercel AI SDK · Vercel Workflow · octokit · sonner · streamdown

## Project Architecture

**Three-layer separation**:
- **Browser/Phone** → user interaction surface
- **Vercel Pro (orchestration)** → receive triggers → read GitHub state → LLM decision → execute → write back
- **GitHub private repo (truth source)** → code (`src/`) + data (`memory/`, `tasks/`, `sessions/`)

**Key principles**:
- Code + data coexist in one repo. Code is agent-read-only, data directories are agent-read-write.
- Execution is stateless and event-driven. State lives entirely in GitHub files, not in a database.
- The agent's identity constitution (`identity/agent/`) is bundled at build time via `scripts/generate-identity.mjs`; all memory data (slices, timeline, strands, user card) is fetched at runtime from GitHub/local fs.

## Commands

- `pnpm dev` — Start dev server with Turbopack (port 3000)
- `pnpm build` — Production build with Turbopack
- `pnpm start` — Start production server
- `pnpm lint` — Run ESLint
- `pnpm test` — Run vitest (unit + integration)
- `npx playwright test` — Run Playwright E2E tests

## Architecture

### Layout Hierarchy

1. **Root Layout** (`src/app/layout.tsx`): Geist fonts + `ThemeProvider` + `<Toaster />`
2. **Locale Layout** (`src/app/[locale]/layout.tsx`): `NextIntlClientProvider` + `<AppSidebar />` + main content
3. **Route-level**: Each route has `loading.tsx` and `error.tsx` for full state coverage

### Internationalization (next-intl)

- **Routing config**: `src/i18n/routing.ts` — supported locales (`en`, `zh`) and default
- **Translations**: `messages/en.json`, `messages/zh.json`
- **Navigation**: Always use utilities from `@/i18n/navigation` instead of `next/navigation`.

### Theme System

- `next-themes` with `attribute="class"`, `defaultTheme="system"`
- `suppressHydrationWarning` on `<html>` tag
- Geist + Geist Mono fonts via `next/font/google`

### shadcn/ui

- Base UI primitives (shadcn's future direction)
- Components: `src/components/ui/` — 28 components (button, card, dialog, drawer, popover, select, tabs, tooltip, command, skeleton, avatar, separator, switch, label, input, textarea, scroll-area, dropdown-menu, sheet, alert, bubble, input-group, message, message-scroller, number-ticker, sonner, text-generate-effect, toggle)
- Utilities: `cn()` from `@/lib/utils`
- Toast notifications: `sonner` via `src/components/ui/sonner.tsx`

### Chat Component Architecture

Streamed message-part rendering. See `src/components/chat/CLAUDE.md` for full details.

1. **`ChatPage`** (`chat-page.tsx`) — Main container, useChat hook (WorkflowChatTransport), TimelineWheel
2. **`ChatMessage`** — Classifies `UIMessage` parts (text / reasoning / tool / data-phase / data-evolution) in a single pass, rendered in stream order
3. **`ThinkingSteps`** — Reasoning block (Brain icon, streaming subtitle)
4. **`PhaseIndicator`** — `data-phase` parts (slicing, housekeeping, etc.)
5. **`EvolutionIndicator`** — Per-bubble card-evolution status (`data-evolution` chunks)
6. **`ToolRenderer`** — Dispatches to per-tool renderers (RecallToolRenderer, MemoryToolRenderer, ListFilesRenderer, WebSearchRenderer, LoopToolRenderer, DefaultRenderer)
7. **`ToolLayout`** — Shared expandable card with status icon/name/summary/expanded content
8. **`ChatInput`** — Text area + image attachments + submit/stop
9. **`MarkdownRenderer`** — `react-markdown` + `remark-gfm` + `rehype-highlight`

### Skills System

- **File-driven**: Skills defined as `SKILL.md` in `.claude/skills/` directories
- **Discovery**: `src/lib/skills/discovery.ts` — scans directories, parses YAML frontmatter
- **Loading**: `src/lib/skills/loader.ts` — extracts body, substitutes `$ARGUMENTS`
- **Registry**: `src/lib/skills/registry.ts` — programmatic + discovered skills

### Providers

- **`ExpandedViewProvider`** — collapse/expand toggle context for tool views
- **`ReasoningProvider`** — thinking/reasoning duration tracking per message
- **`TodoViewProvider`** — todo panel visibility toggle

### Path Aliases

- `@/*` → `./src/*`

## Core Modules (Previously On unique designs — not from Open Agents)

| Module | Path | Purpose |
|--------|------|---------|
| Capabilities | `src/lib/capabilities.ts` | Global app-mode checks: isAIConfigured, isDemo, canWrite, getRepoConfig (delegates data-source decisions to `src/lib/data-source/resolve.ts`) |
| Loop Engine | `src/app/api/loops/loop-workflow.ts` | Durable background task execution with Vercel Workflow; run persistence in `src/lib/loops/` (store, guards, types) |
| GitHub Tools | `src/lib/tools/` | readFile/writeFile/listFiles via Octokit |
| Path Whitelist | `src/lib/whitelist/` | Security boundary: memory/tasks/sessions only |
| Origin Guard | `src/lib/security/origin-guard.ts` | Same-origin guard on POST mutation endpoints (`/api/chat`, `/api/loops`, `/api/episodic/flush`); optional `ACCESS_SECRET` key check for non-browser callers |
| Session Manager | `src/lib/session/` | In-memory session state with sliding window (legacy) |
| Model Registry | `src/lib/models/` | models.dev-driven catalog, provider dispatch, worker model resolution |
| Time Rendering | `src/lib/time/relative.ts` + `src/lib/episodic/time-localize.ts` | Locale-aware relative-time annotations on slices/timeline/card reads, computed against the user's timezone |
| Turn Priming | `src/lib/turn-priming.ts` | Per-turn engineering brief (time/timezone, date-anchor table, continuity tier, strand links, overdue Horizon items, intent) injected at the top of the system prompt |
| Turn Analyzer | `src/lib/episodic/flash/turn-analyzer.ts` | The one worker-model call in housekeeping: message tags + semantic hint + intent + `memory_worthy` / `memory_update` + (on close) slice marking and the `evolve_card.worth` gate |

### Episodic Memory (M8 — Time-Slice System)

The episodic memory subsystem (`src/lib/episodic/`, see `src/lib/episodic/CLAUDE.md`) is the memory layer:

- **Structure**: `memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md` — one directory per time slice (`timeline/core.md` + `agent.md` + a `previously.md` card snapshot), YAML frontmatter + conversation turns
- **Worker/main split**: The resolved WORKER model (`src/lib/models/worker.ts` — a cheap tier derived from the main model's provider, configurable in config.json) runs the housekeeping calls: recall scanning, and the unified turn analyze (message tags + semantic hint + intent + slice marking). The main model handles the user-facing reply.
- **Close-time marking**: when a slice closes, the housekeeping analyze call produces its `focus` / `summary` / refined `tags` / `emotional_tone`, written into the frontmatter before the slice persists — so the global timeline and recall see real descriptions, not "(none)".
- **Slicing**: time-driven — 30 minutes of inactivity closes the current slice, a 20-turn capacity cap, and context-loss detection (`context_lost`).
- **Write discipline**: batched writes go through an explicit `WriteBatch` (`createBatch()` → `flushBatch()`, `io-helpers.ts`); housekeeping/finalizeTurn on the same slice serialize through a per-sliceId mutex (`slice-mutex.ts`); write conflicts self-heal via append-only turn merge (`turn-merge.ts`).
- **Timeline**: per-slice `timeline/core.md` + `agent.md` are woven into the global timeline (`timeline/weave.ts`, `timeline/store.ts`, `timeline/render.ts`); `flash/global-timeline.ts` aggregates slice summaries and `flash/backfill-marks.ts` backfills close-time markings on historical slices.
- **Card evolution**: at a slice boundary the Previously Agent edits the card through validated mutation tools (`card-session.ts`); there is no mechanical card pass — expiry/caps/overdue handling are the agent's decisions, enforced inside the tools.
- **Strands** (semantic layer): a slice carries `tags` (keywords); a **strand** is a keyword woven through all the slices that carry it. `memory/episodic/strands.json` maps each strand → its slice paths ("the whole history of that thing" across time) — the thin, lossless semantic-memory index over the episodic slices. Built at slice-close via `updateStrands`; `flash/strand-consolidator.ts` merges near-duplicate strands; a richer first-class strand (rolling summary + recall integration) is a future milestone.
- **Demo data source**: `STORAGE=demo` (or auto-detected when no `GITHUB_TOKEN` and not dev) makes memory reads read-only against remote benchmark data. There is no `DEMO_MODE` env var — data-source resolution lives in `src/lib/data-source/resolve.ts`.

### Model Layer (multi-provider + worker tier)

- **Catalog**: models.dev (`https://models.dev/api.json`) is the primary model catalog (`src/lib/models/catalog.ts`), gated by configured API-key env vars and reverse-filtered against each provider's live `/models` endpoint. Falls back to a curated list in `src/lib/models/registry.ts`.
- **Dispatch**: `src/lib/models/provider.ts` routes by SDK — dedicated `@ai-sdk/deepseek` / `@ai-sdk/anthropic`, OpenAI-compatible catch-all (`@ai-sdk/openai`) for everything else (Kimi, Qwen, ...).
- **Two tiers**:
  - **Main model** — user-selected in the chat toolbar; persists to `memory/user/config.json` (cross-device, no localStorage).
  - **Worker model** — the cheap internal tier (housekeeping analyze, recall search, belief evolution, loops). Resolved by `resolveWorkerModel()` (`src/lib/models/worker.ts`): manual pin → same-provider lightweight → the main model. Configured in the model selector's "Advanced" sheet (auto "keep consistent with the main agent", or a manual pick).
- **Workflow model deserialization**: `register-model-classes.ts` registers deepseek, anthropic, and openai(-compatible) model hosts so models crossing the workflow→step boundary rebuild correctly.

### Chat Rendering

The chat component tree (`src/components/chat/`, see `src/components/chat/CLAUDE.md`) renders each assistant message as typed `UIMessage` parts in stream order:

1. **Evolution status** — `EvolutionIndicator` at the top of the latest assistant bubble, driven by `data-evolution` chunks.
2. **Reasoning** — `ThinkingSteps` (Brain icon), consecutive reasoning parts merged into one block.
3. **Phases** — `PhaseIndicator` for `data-phase` parts (slicing, housekeeping, etc.).
4. **Tool calls** — `ToolRenderer` dispatches to per-tool renderers; recall renders as `RecallToolRenderer` with matched slices.
5. **Response text** — `MarkdownRenderer` blocks interleaved in natural stream order.

Tool calls use friendly outer labels with real tool names in expanded view.

## Project Documentation

`doc/` is gitignored — it holds local design docs and release notes only.

| File | Purpose |
|------|---------|
| `doc/design/` | Per-milestone design documents (`v0.5-previously-agent.md`, `v0.7-memory-card.md`, `v0.8-timeline.md`) |
| `doc/v0.5-changelog.md` / `doc/v0.5-release-notes.md` | v0.5 changelog + release notes |
| `doc/v0.7-changelog.md` / `doc/v0.7-release-notes.md` | v0.7 changelog + release notes |

## Testing

### Three-layer testing strategy

| Layer | Tool | Target | Location |
|-------|------|--------|----------|
| **Unit + Integration** | Vitest (`node` env) | Pure functions, tool logic, serialization, guards | `tests/lib/` matching `src/lib/` structure, or co-located `__tests__/` |
| **Component E2E** | Playwright | Individual UI modules — render states, interactions | `tests/e2e/` |
| **Flow E2E** | Playwright | Connected user journeys across multiple modules | `tests/e2e/` |

### Test file conventions

- **Vitest**: `tests/<path>/<name>.test.ts` mirroring `src/<path>/<name>.ts`, or `src/<path>/__tests__/<name>.test.ts` for co-located tests. Both patterns exist; match the surrounding convention.
- **Playwright**: `tests/e2e/<name>.spec.ts`. Desktop (1280×720 Chrome) and mobile (iPhone 13) projects.
- Use `vi.mock()` with inline factories for module-level mocks. Use `vi.hoisted()` when mock values are referenced in both the factory and assertions.
- Use `vi.stubEnv()` or direct `process.env` manipulation for env-dependent modules (the project currently uses both; prefer `vi.stubEnv()` for new tests).
- Use `vi.useFakeTimers()` / `vi.setSystemTime()` for time-dependent tests.

### Testing requirements (mandatory)

1. **New features and modules must have accompanying tests.** Every new module, tool executor, guard, or pure function ships with a corresponding test file. The exit criteria is that `pnpm test` passes with zero failures.
2. **Changes to existing code must not break existing tests.** Unless the change is explicitly a functional or architectural pivot (which must be stated up front), the existing test suite must stay green. Run `pnpm test` before committing any change to existing code.
3. **If a change requires modifying existing tests to pass, explain why.** Modifying test assertions to match new behavior is sometimes correct — but it means the contract changed. Flag this to the user before doing it, with a clear rationale for why the old behavior is being dropped.

### What to test

- **New pure functions**: mandatory. If a function has no I/O and no side effects, it must have deterministic unit tests.
- **New tool executors / guards**: mandatory. Every rejection path and edge case must be covered.
- **Bug fixes**: must include a regression test.
- **UI components with conditional rendering** (loading/empty/error/success): should cover each state.
- **E2E**: at minimum, the core demo-user journey (open → chat → timeline → settings).

### Capabilities module

`src/lib/capabilities.ts` is the single source of truth for app-mode checks; data-source decisions delegate to `src/lib/data-source/resolve.ts` (`STORAGE=local|github|demo`, auto-detected when unset). All engineering-side code (tool executors, server components, API routes) should import from here instead of reading `process.env` directly. The AI model layer does NOT import capabilities — it learns about limitations through tool-executor rejections.

```
STORAGE set?                          (auto-detect when unset)
├─ local   → Local filesystem: full read/write (dev default)
├─ github  → GitHub API: full read/write, loops available (needs GITHUB_TOKEN)
└─ demo    → Remote benchmark data: read-only, CANNOT write, CANNOT loop
AI calls require at least one configured provider key (see getConfiguredProviders()).
```

## Current Phase (v0.8)

**Goal**: Timeline-centric memory — the per-slice `timeline/core.md` + `agent.md` files are woven into a navigable global timeline; the user card is **v5** (Identity head / Past: rolling profile paragraph + anchor facts / Now: agent-expired hooks / Horizon: future commitments with `by` dates / Self-model: delta from DIRECTIVES) with hard caps enforced inside the agent's mutation tools (`card-session.ts`: Now ≤ 5, anchors ≤ 8, Horizon ≤ 5, self-model ≤ 10, profile ≤ 2400 chars); and every mutation endpoint sits behind the same-origin guard.

Branch: `feature/v0.8-timeline`

Key pieces:

- **Durable turn**: every chat turn runs in a Vercel Workflow run (`src/app/api/chat/turn-workflow.ts`) via AI SDK's `WorkflowAgent` with `stopWhen: isStepCount(20)`; timed-out steps are re-invoked with a continuation nudge under a hard cap (bounded continuations).
- **Evolution triggers**: at a slice boundary the turn analyzer's `evolve_card.worth` gate decides whether the Previously Agent (worker model) runs; a legacy (pre-v5) card forces a run so format migration never waits. The agent edits the card through per-entry mutation tools (`card-session.ts`) — over-limit writes are rejected with compression instructions, never silently truncated. An explicit user request or behavioral correction in the analyzer's `memory_update` field widens the fold-in beyond the boundary trigger.
- **Timeline subsystem**: `src/lib/episodic/timeline/` (weave / store / render / enumerate) plus `flash/global-timeline.ts` and `flash/backfill-marks.ts`.
- **Time rendering**: all read tools and the system prompt annotate ISO timestamps with the user's local/relative time (`src/lib/time/relative.ts`, `time-localize.ts`); `turn-priming.ts` injects a precomputed date-anchor table so the model never does date arithmetic.
- **Endpoint origin guard**: `src/lib/security/origin-guard.ts` blocks non-same-origin POSTs to `/api/chat`, `/api/loops`, `/api/episodic/flush`; when `ACCESS_SECRET` is set, non-browser callers must send `x-access-key`.

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- The flush/episodic write path is further constrained to the active slice's timeline files (strict slice-id validation in `src/app/api/episodic/flush/route.ts`)
- API mutation endpoints (`POST /api/chat`, `/api/loops`, `/api/episodic/flush`) are same-origin guarded — see `src/lib/security/origin-guard.ts`; non-browser callers need `x-access-key` when `ACCESS_SECRET` is set
- `src/` directory is agent-read-only — no tool may modify it
- GitHub token is scoped to a single repository with contents read/write only
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)
- **`maxOutputTokens` is NEVER set** on any model call (agent, thinkDeep, loop, worker). It behaves inconsistently across providers — with DeepSeek thinking enabled the reasoning silently eats the shared cap and leaves empty/truncated output. Steps are bounded by the platform's 300s wall; on a kill the turn workflow continues the agent with a nudge (see `turn-workflow.ts`). Don't reintroduce it as a timeout or output guard.
