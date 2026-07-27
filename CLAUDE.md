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
- Memory is layered: L0/L1 bundled at build time, L2 fetched on-demand at runtime.

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

Three-phase message rendering (M8). See `src/components/chat/CLAUDE.md` for full details.

1. **`ChatPage`** (`chat-page.tsx`) — Main container, useChat hook, TimelinePanel, MessageScroller
2. **`ChatMessage`** — Three-phase rendering: Recall → Reasoning → Response
3. **`RecallPhase`** — Flash recall results with expandable matched slices (ToolLayout + History icon)
4. **`ThinkingSteps`** — Pro reasoning block (ToolLayout + Brain icon, MarkdownRenderer)
5. **`ToolRenderer`** — Dispatches to per-tool renderers (MemoryToolRenderer, DefaultRenderer, etc.)
6. **`ToolLayout`** — Shared expandable card with status icon/name/summary/expanded content
7. **`ChatInput`** — Text area + submit/stop
8. **`MarkdownRenderer`** — `react-markdown` + `remark-gfm` + `rehype-highlight`
9. **`FileNamePill`** — File path pill with icon (used by tool renderers)

### Skills System

- **File-driven**: Skills defined as `SKILL.md` in `.claude/skills/` directories
- **Discovery**: `src/lib/skills/discovery.ts` — scans directories, parses YAML frontmatter
- **Loading**: `src/lib/skills/loader.ts` — extracts body, substitutes `$ARGUMENTS`
- **Registry**: `src/lib/skills/registry.ts` — programmatic + discovered skills
- **Built-in**: `/create-memory` — creates memory nodes in `memory/nodes/`

### Providers

- **`ExpandedViewProvider`** — collapse/expand toggle context for tool views
- **`ReasoningProvider`** — thinking/reasoning duration tracking per message
- **`TodoViewProvider`** — todo panel visibility toggle

### Path Aliases

- `@/*` → `./src/*`

## Core Modules (Previously On unique designs — not from Open Agents)

| Module | Path | Purpose |
|--------|------|---------|
| Capabilities | `src/lib/capabilities.ts` | Global app-mode checks: isAIConfigured, isDemo, canWrite, getRepoConfig |
| Loop Engine | `src/lib/loops/` | Durable background task execution with Vercel Workflow |
| GitHub Tools | `src/lib/tools/` | readFile/writeFile/listFiles via Octokit |
| Path Whitelist | `src/lib/whitelist/` | Security boundary: memory/tasks/sessions only |
| Memory System | `src/lib/memory/` | Markdown nodes with YAML frontmatter + scoring |
| Intent Router | `src/lib/router/` | Flash classifier + keyword hybrid intent routing |
| Context Assembler | `src/lib/context/` | 6-layer context assembly with token budget |
| Session Manager | `src/lib/session/` | In-memory session state with sliding window |
| Archive Sync | `src/lib/archive/` | GitHub archive push with retry/backoff |
| Model Registry | `src/lib/models/` | DeepSeek model routing + thinking toggle |

### Episodic Memory (M8 — Time-Slice System)

The episodic memory subsystem (`src/lib/episodic/`, see `src/lib/episodic/CLAUDE.md`) is the L2 memory layer:

- **Structure**: `memory/episodic/slices/YYYY/MM/DD/HHMM.md` — one file per time slice (a day is a directory), YAML frontmatter + conversation turns
- **Flash/Pro split**: Flash (DeepSeek-chat) handles per-request recall scanning + metadata maintenance. Pro (main model) handles deep recall via `readMemory` tool.
- **Slicing**: Pure time-driven — 30 minutes of inactivity closes the current slice. No capacity or topic-shift rules.
- **Strands** (semantic layer): a slice carries `tags` (keywords); a **strand** is a keyword woven through all the slices that carry it. `memory/episodic/strands.json` maps each strand → its slice paths ("the whole history of that thing" across time) — the thin, lossless semantic-memory index over the episodic slices. Built at slice-close via `updateStrands`; a richer first-class strand (rolling summary + recall integration) is a future milestone.
- **DEMO_MODE**: `DEMO_MODE=true` redirects `memory/` reads to `memory/demo/personal_14/` (Caleb persona, 30+ slices). Writes go to real `memory/`.

### Chat Rendering

The chat component tree (`src/components/chat/`, see `src/components/chat/CLAUDE.md`) renders messages in three phases:

1. **Recall Phase** — `RecallPhase` (History icon, ToolLayout). Shows Flash recall results with matched slices, reasoning, and tags.
2. **Reasoning Phase** — `ThinkingSteps` (Brain icon, ToolLayout). Pro's internal reasoning before responding.
3. **Response Phase** — `Bubble` containing tool calls (ToolRenderer, inline order) + Markdown text.

Tool calls use friendly outer labels (`Recalling in detail...`, `Recalling more...`) with real tool names in expanded view.

## Project Documentation

| File | Purpose |
|------|---------|
| `doc/project-info.md` | Project soul: one-liner, architecture, current focus |
| `doc/requirements.md` | Feature specs in BDD/Gherkin format |
| `doc/solution.md` | Technical solution with option comparisons |
| `doc/roadmap.md` | Milestone + task breakdown |
| `doc/design/` | Per-milestone design documents |
| `doc/preferences.md` | Development preferences and constraints |
| `doc/dev.md` | Dev commands, references, and development log |
| `doc/progress.md` | Current task status and history |

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

`src/lib/capabilities.ts` is the single source of truth for app-mode checks. All engineering-side code (tool executors, server components, API routes) should import from here instead of reading `process.env` directly. The AI model layer does NOT import capabilities — it learns about limitations through tool-executor rejections.

```
DEEPSEEK_API_KEY set?
├─ NO  → App non-functional. Show setup guidance.
└─ YES → GITHUB_TOKEN set?
          ├─ NO  → Demo mode: can chat, CANNOT write, CANNOT loop.
          └─ YES → Production: full read/write, loops available.
```

## Current Phase (v0.5)

**Goal**: Re-enable background loop capability with a global capabilities module. The `startLoop` agent tool is now bound for all users; in demo mode the executor returns a model-facing rejection so the model explains the deployment requirement naturally.

Branch: `feat/v0.5-loop-reenable`

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- `src/` directory is agent-read-only — no tool may modify it
- GitHub token is scoped to a single repository with contents read/write only
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)
