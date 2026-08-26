# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## About

A Next.js web application with a server-side LLM agent and a GitHub-backed episodic memory system (conversation history stored as time slices). The agent operates only on whitelisted data directories; every chat turn runs inside a durable Vercel Workflow run.

**Tech stack**: Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Vercel AI SDK · Vercel Workflow · octokit · sonner · react-markdown (remark-gfm · remark-math/KaTeX · rehype-highlight · mermaid)

## Commands

- `pnpm dev` — Start dev server with Turbopack (port 3000)
- `pnpm build` — Production build with Turbopack
- `pnpm build:standalone` — Build + dereference all symlinks in `.next/standalone` (see Packaging below)
- `pnpm start` — Start production server
- `pnpm lint` — Run ESLint
- `pnpm test` — Run vitest
- `pnpm test:e2e` — Playwright UI E2E (`tests/e2e/`); boots its own dev server on port 3100 in client + subscription-bridge mode (`PREVIOUSLY_MODE=client`, `PREVIOUSLY_BRAIN=bridge`) against isolated temp `PREVIOUSLY_HOME`/`MEMORY_ROOT` dirs — never the real `~/.previously`. First run needs `npx playwright install chromium`.

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
- **Pure time-based slicing** (v0.9): a slice force-closes `slicing.maxSliceMinutes` (default 30) after its start; `maxTurnsPerSlice` (default 50) is a pure safety valve; client-history mismatch closes with `context_lost`. The history window is slice-aligned — the server trims client history to the current slice's turn count instead of a fixed recent-N.
- **Slice-frozen system prompt** (v0.9): the system prompt is layered L0–L5 and anchored to the slice start, so it is byte-stable within a slice to maximize provider prefix caching (DeepSeek caches prefixes automatically; the Anthropic path gets explicit ephemeral `cacheControl` breakpoints in `src/app/api/agent/agent.ts`). Everything that changes per turn left the system prompt — the model reads the precise time through the `currentTime` tool.
- **Unified sub-agent runner** (v0.9): all sub-agents (card evolution, recall, flash-search, turn-analyzer, strand-consolidator, backfill-marks) run through `src/lib/agents/sub-agent-runner.ts` on the MAIN model with thinking ON at low effort; their prompts share `SHARED_SUBAGENT_BASE` (`src/lib/agents/prompts.ts`). The runner uses `streamText` (thinkDeep-style): reasoning/text stream LIVE as the current line — onto `data-tool-progress` when a `toolCallId` exists, or through the `onLine` callback for non-tool callers (the Previously Agent's lines ride the `data-evolution` channel, id `evolution`, throttled 40ms in `src/app/api/chat/steps.ts`); timeouts return the accumulated partial. Single model: everything runs on the selected model — the old worker tier and its manual pin are gone (model resolution helpers live in `src/lib/models/resolve.ts`).
- The user card (`memory/episodic/current-previously.md`) is v5 format: Identity / Past (rolling profile paragraph + anchor facts) / Now (7-day expiry hooks) / Horizon (future commitments with `by` dates) / Self-model.
- Deployment mode is resolved only by `src/lib/mode.ts` (`PREVIOUSLY_MODE=cloud|client`, default `cloud`); in client mode the datasource auto-detect default is `local`. For local storage, whitelisted `memory/` paths re-root at the `MEMORY_ROOT` env var (absolute path) when set — see `getMemoryRoot`/`resolveLocalDataPath` in `src/lib/whitelist/`. `GET /api/version` returns `{ version, mode }` for client compat checks.
- Client mode additionally registers the chat-only `delegateTask` tool (subscription bridge dispatch): it spawns the operator-controlled `PREVIOUSLY_BRIDGE_CMD` (default `previously bridge-exec`) with a JSON `{ task, context, protocol: 2 }` payload on stdin and returns its stdout, bounded by `PREVIOUSLY_BRIDGE_TIMEOUT_MS` (default 10 min). Protocol 2 stdout is NDJSON: live `{"event": {name, summary, status}}` tool-activity lines and advisory `{"delta": "<text>"}` text-chunk lines (claude adapter only — the envelope `result` stays the source of truth, consumers reconcile to it) followed by a final `{"protocol": 2, "result", "events"}` envelope (a batch envelope alone also works); stdout without an envelope stays legacy plain text (30k cap; envelope results get 512k). The client CLI injects `PREVIOUSLY_BRIDGE_CMD` at kernel spawn time as the registered command name `previously bridge-exec` (spawn env only — never shell-level env vars); the kernel's spawn resolves bare names against PATH and routes Windows `.cmd`/`.bat` shims through `cmd.exe` (`resolveBridgeSpawnTarget`, mirrored from the client runner — shell-less spawn cannot execute shims); resolving/invoking the actual agent CLIs is the client's job (`bridge-exec`), and a missing bridge command surfaces an honest `bridge-not-found` error telling the user to configure manually — the kernel never guesses or falls back. Bridge failures surface as structured tool errors, never faked success. The shared spawn/env contract lives in `src/lib/bridge.ts`.
- Pure subscription mode (`PREVIOUSLY_BRAIN=bridge` + `PREVIOUSLY_BRAIN_AGENT=claude|codex|kimi`, client mode only — OR `brain.type === "bridge"` in `PREVIOUSLY_HOME/config.json`, the settings-UI engine switch; either source registers the bridge entries, the config brain's agent wins the default ordering, and POST /api/client/config resets the catalog cache, so engine switches apply without a restart): with no model API keys, the chat MAIN model itself runs through the bridge — a custom AI SDK LanguageModel (`src/lib/models/bridge-model.ts`, dispatched in `src/lib/models/provider.ts`). Every agent CLI registers as a selectable model (`bridge/claude` / `bridge/codex` / `bridge/kimi` in `src/lib/models/registry.ts`, env-selected agent first = default); the model id picks the agent per call (pinned via `PREVIOUSLY_BRAIN_AGENT` in the spawn env), so switching agents in the selector needs no restart. It streams the chat answer live when the CLI emits protocol-2 `{"delta"}` lines (claude adapter) — deltas become text-delta parts and reconcile to the envelope `result` at completion (the result wins; divergent deltas are re-emitted as the authoritative block); with no deltas (codex/kimi, legacy CLIs) it honestly replays the one-shot result as a single delta. It mounts no kernel tools on the chat agent (the system prompt says so), and bridge failures throw as model errors. Sub-agent calls (recall, turn-analyzer, …) DO get structured reports over the bridge: when the call offers function tools, a text tool protocol is appended to the task and the CLI's trailing `{"tool": name, "input": {...}}` JSON is parsed back into a real tool-call part (server-side-executing kernel tools like recall's search tools actually run; a missing required report tail is a fatal `invalid-report` model error). Protocol-2 live events surface as a `data-phase` "Working…" indicator whose summaries accumulate the CLI's activity lines and whose `tools` array feeds the generic bridge-tool indicator (`src/components/chat/bridge-tools-card.tsx`, one row per tool event) — written directly to the run writable via `createBridgeEventEmitter` (unknown chunk types cannot ride the model stream). Memory access on the bridge side goes through the per-call skills workspace the client CLI spawns the agent in — instruction files (CLAUDE.md / AGENTS.md) explaining how to read Previously's read-only markdown memory — not through kernel tools. The brain source is a SINGLE SWITCH: sub-agents (housekeeping/recall/belief evolution) resolve to the same bridge model as the main chat (each sub-agent call is a CLI subprocess on the user's subscription quota). `/api/models` marks bridge options with `hint` + `available` (PATH detection, `src/lib/client-detect.ts`).
- Phase outsourcing (experimental, client+bridge mode): instead of each housekeeping sub-agent spawning its own CLI over the bridge, the whole housekeeping phase is outsourced as ONE bridge call — `runHousekeepingBridge` (`src/lib/bridge-phases.ts`) sends `{task, context, phase: "housekeeping", protocol: 2}` and expects a single JSON report (turn analysis + optional closed marking + card-evolution mutations + dry-slice backfill marks + strand merge proposals); the kernel validates it (zod, strand-name matching, card-session mutation caps, offered-candidate allowlists for backfill slice ids and strand merge keys — the strand pass replaces the consolidator's LLM merge under the same close-boundary + `MIN_STRANDS_FOR_LLM` gate and applies through the same `applyStrandMerges`) and applies it through the same write paths (`applyMarksToDrySlices` shared with the legacy per-slice backfill), degrading deterministically on any failure (never throws). Chat calls carry `phase: "chat"` plus a `skills` key (`src/lib/bridge-skills.ts` — business text is single-sourced kernel-side and shipped in the payload); the client workspace materializes thin phase skill docs + `skills/recall.md` and exposes constrained read-only reader commands (`readslice`/`timeline`/`strands`/`card`/`slicesummary`/`agentlog`, flag surface mirrors the kernel tool schemas — the old `previously recall` command is gone: memory search is a CLI-side sub-agent following the kernel-supplied recall skill). A normal turn is exactly two client-agent calls (housekeeping + chat). The housekeeping phase renders its OWN streaming card (`src/components/chat/bridge-housekeeping-card.tsx`, phase `bridgeHousekeeping`) instead of the edge-mode HousekeepingCard checklist: protocol-2 tool events and `{"delta"}` narration lines are forwarded live (`onEvent`/`onDelta` → `createBridgeEventEmitter` on the step's stream queue — for `phase: "housekeeping"` the client suppresses the JSON report block, so deltas are display-safe), and the kernel's deterministic wrap-up outcomes (slice / analyze / tags / context / strands) fill in as checklist rows on the same card (`data.steps`, folded into every cumulative frame — build-stream merges last-chunk-wins). Kill-switch: `PREVIOUSLY_PHASE_OUTSOURCE=0` restores the per-sub-agent bridge path. See `doc/design/v0.9-client.md` §11.
- Client-mode settings APIs: `GET /api/client/status` (mode/version/home/memoryRoot/bridge/models), `GET /api/client/agents` (PATH detection of the bridge agent CLIs — claude/codex/kimi, timeout-bounded; see `src/lib/client-detect.ts`), and `GET|POST /api/client/config` (read/update `executionBackend` + `brain` + `agents` — per-agent bridge model/effort defaults — + `byok` in `PREVIOUSLY_HOME/config.json`, unknown fields preserved; see `src/lib/client-config.ts`). All 404 in cloud mode; POST is origin-guarded. The settings page renders a "Client" section only in client mode.
- BYOK (bring-your-own-key, client mode's second engine next to the subscription bridge — the recommended path): the `byok` section of `config.json` (`{ provider, apiKey, baseUrl?, model }`; provider is a preset from `BYOK_PROVIDERS` in `src/lib/models/registry.ts` or `custom` with an explicit baseUrl) registers one selectable model `byok/<model>` (provider `byok`, listed after the bridge entries) in `src/lib/models/catalog.ts`. It always dispatches through the OpenAI-compatible sdk path so the workflow step serialization round-trips the apiKey (`register-model-classes.ts`); `createModel` prefers `config.apiKey` over the env key and keys its provider cache on both. The local GET snapshot returns the apiKey in plaintext (single-user local state — never log it). Under a BYOK model, phase outsourcing is automatically off — the gate `isPhaseOutsourceActive(modelSdk)` also requires the turn's model to be a bridge model, so housekeeping runs on the standard API sub-agent path.
- Client-mode header badge (`src/components/layout/client-badge.tsx`, mounted in `app-header.tsx`): mirrors the Demo badge but self-gates at runtime — fetches `/api/version` on mount and renders only when `mode === "client"` (pages are prerendered before mode is known). `NEXT_PUBLIC_PREVIOUSLY_TARGET` is the build-time switch: `client` (set by `pnpm build:standalone`, the kernel packaging build) keeps client-only UI; `cloud` tree-shakes it out of the browser bundle; unset keeps runtime-gated behavior for local dev.

## Packaging (supply chain)

The client deployment ships `.next/standalone`, but Next mirrors the pnpm layout with symlinks — on Windows these come out broken (file-type links to dir targets, absolute links back into the build repo), so the artifact is not relocatable as-built. `scripts/pack-standalone.mjs` replaces every symlink in the standalone tree with the real content of its resolved target, producing a pure file tree (zero symlinks). CI must run `pnpm build:standalone` (build + pack) before packaging the `previously-kernel` artifact.

`pnpm build:standalone` runs `scripts/build-standalone.mjs`, a cross-platform wrapper (inline env vars in package.json scripts break on Windows cmd) that sets `NEXT_PUBLIC_PREVIOUSLY_TARGET=client`, then spawns `pnpm build` and the pack step.

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
- API mutation endpoints (`POST /api/chat`, `/api/episodic/flush`) are same-origin guarded — see `src/lib/security/origin-guard.ts`; non-browser callers need `x-access-key` when `ACCESS_SECRET` is set
- `src/` directory is agent-read-only — no tool may modify it
- All path validation is server-side; client is untrusted
- Base UI is the standard shadcn/ui primitive library (not Radix UI)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
