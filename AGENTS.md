# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## About

A Next.js web application with a server-side LLM agent and a GitHub-backed episodic memory system (conversation history stored as time slices). The agent operates only on whitelisted data directories and can spawn durable background loops (Vercel Workflow).

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Vercel AI SDK · Vercel Workflow · octokit · sonner · streamdown

## Commands

- `pnpm dev` — Start dev server with Turbopack (port 3000)
- `pnpm build` — Production build with Turbopack
- `pnpm start` — Start production server
- `pnpm lint` — Run ESLint
- `pnpm test` — Run vitest

## Architecture

Three-layer separation:
- **Browser/Phone** → user interaction surface
- **Vercel (orchestration)** → receive triggers → read GitHub state → LLM decision → execute → write back
- **GitHub repo (truth source)** → code (`src/`) + data (`memory/`, `tasks/`, `sessions/`)

**Key principles**:
- Code + data coexist in one repo. Code is agent-read-only, data directories are agent-read-write.
- Execution is stateless and event-driven. State lives entirely in GitHub files, not in a database.
- Memory is layered: L0/L1 bundled at build time, L2 fetched on-demand at runtime.
- Context is assembled dynamically from a timeline of time slices — no growing prompt window.

## Project Documentation

| File | Purpose |
|------|---------|
| `doc/project-info.md` | Project one-liner, architecture, current focus |
| `doc/requirements.md` | Feature specs in BDD/Gherkin format |
| `doc/solution.md` | Technical solution with option comparisons |
| `doc/roadmap.md` | Milestone + task breakdown |
| `doc/design/` | Per-milestone design documents |
| `doc/dev.md` | Dev commands, references, and development log |
| `doc/progress.md` | Current task status and history |

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- `src/` directory is agent-read-only — no tool may modify it
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
