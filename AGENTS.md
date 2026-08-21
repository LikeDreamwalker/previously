# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## About

A Next.js web application with a server-side LLM agent and a GitHub-backed episodic memory system (conversation history stored as time slices). The agent operates only on whitelisted data directories and can spawn durable background loops (Vercel Workflow).

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Vercel AI SDK · Vercel Workflow · octokit · sonner · react-markdown (remark-gfm · remark-math/KaTeX · rehype-highlight · mermaid)

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
- The agent's identity constitution (`identity/agent/`) is bundled at build time via `scripts/generate-identity.mjs`; all memory data (slices, timeline, strands, user card) is fetched at runtime from GitHub/local fs.
- Context is assembled dynamically from a timeline of time slices — no growing prompt window.
- The user card (`memory/episodic/current-previously.md`) is v5 format: Identity / Past (rolling profile paragraph + anchor facts) / Now (7-day expiry hooks) / Horizon (future commitments with `by` dates) / Self-model.

## Project Documentation

`doc/` is gitignored — it holds local design docs and release notes only.

| File | Purpose |
|------|---------|
| `doc/design/` | Per-milestone design documents (`v0.5-previously-agent.md`, `v0.7-memory-card.md`, `v0.8-timeline.md`) |
| `doc/v0.5-changelog.md` / `doc/v0.5-release-notes.md` | v0.5 changelog + release notes |
| `doc/v0.7-changelog.md` / `doc/v0.7-release-notes.md` | v0.7 changelog + release notes |
| `doc/v0.8.1-changelog.md` / `doc/v0.8.1-release-notes.md` | v0.8.1 patch changelog + release notes |

## Constraints

- Agent tools operate on whitelisted paths only: `memory/`, `tasks/`, `sessions/`
- The flush/episodic write path is further constrained to the active slice's timeline files (strict slice-id validation in `src/app/api/episodic/flush/route.ts`)
- API mutation endpoints (`POST /api/chat`, `/api/loops`, `/api/episodic/flush`) are same-origin guarded — see `src/lib/security/origin-guard.ts`; non-browser callers need `x-access-key` when `ACCESS_SECRET` is set
- `src/` directory is agent-read-only — no tool may modify it
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
