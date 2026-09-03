# Episodic Memory Subsystem

## Overview

The episodic memory subsystem records, indexes, and recalls conversation history as discrete **time slices** -- one per real conversation session (closed by slice age — 30 min from slice start, context loss, or a 50-turn safety cap), stored as Markdown files with YAML frontmatter. A calendar day is a *directory* that may hold multiple slice files. Only the identity constitution (`identity/agent/`) is bundled at build time; all episodic data is fetched on-demand at runtime.

All internal sub-agent calls — recall search, the unified turn analyze (tag extraction + semantic hint + intent + slice marking), belief evolution (the Previously Agent), strand consolidation, mark backfill — run on the MAIN model through the shared sub-agent runner (`src/lib/agents/sub-agent-runner.ts`, thinking ON at low effort, shared `SHARED_SUBAGENT_BASE` prompt prefix). Single model: everything runs on the selected model — the old worker tier is gone. The main model handles user-facing chat. The core agent only reads memory; writes to tags/strands happen mechanically in the housekeeping step.

File storage is abstracted behind a local-filesystem vs. GitHub API switch, gated on `GITHUB_TOKEN`. All paths are under `memory/episodic/`.

## File Map

| File | Role |
|------|------|
| `types.ts` | All type definitions: `TimeSlice`, `Turn`, `SliceFrontmatter`, `SlicingSignal`, `EmotionalTone`, `SliceIndexEntry`, `MonthlyIndex`, `StrandIndex` |
| `index.ts` | Barrel export -- re-exports from `manager.ts` and `slicer.ts` |
| `manager.ts` | Core CRUD: in-memory active slice, path helpers, gray-matter serialization/parsing, turn append, snapshot saves, monthly index and tag index maintenance, previously.md I/O |
| `slicer.ts` | Slicing decision engine — slice age cap (30 min from slice start) |
| `maintenance.ts` | Deprecated v1 module — retained as a stub. Sub-agent calls now live in `flash/recall.ts`, `flash/previously-agent.ts`, and `flash/turn-analyzer.ts`. |
| `actions.ts` | Server actions (`"use server"`) for UI consumption: `getEpisodicState`, `getMoreSlices`, `getSliceContent`. Drives the episodic sidebar panel. |
| `turn-parser.ts` | Pure functions to parse core.md into frontmatter + parsed turns, apply range filters, reassemble filtered slices |
| `flash/recall.ts` | Recall sub-agent colleague (main model via the shared runner) — answers natural-language questions about past conversations, reading slices itself (timeline/strands/summaries/full reads, quota-bounded); every situational claim is anchored to verbatim-quote references |
| `flash/turn-analyzer.ts` | The one housekeeping sub-agent call (main model via the shared runner): message tags + semantic hint + intent + (on close) slice marking + fitness scoring (Task 7 — per-slice evidence-anchored deltas per bucket, v1.0 §2.5; this slice's mechanical signals are an input) |
| `flash/global-timeline.ts` | Global timeline file aggregating all slice summaries |
| `flash/previously-agent.ts` | Previously Agent (main model via the shared sub-agent runner, thinking ON at low effort) — the evolution loop's MERGED run (v1.1): at a slice boundary it evaluates direction.md FIRST (the optional `directionEval` input; moves are ATOMIC direction mutation ops — addPortraitEntry / addHypothesis / promoteHypothesis / … — on a working copy, per-op validated by `applyDirectionOps` with code-stamped `proposed` pointers; the caller runs the whole-doc gate + the engineering hypothesis TTL and applies via `writeDirection`), then edits the user card under the possibly-new portrait through validated MUTATION tools (never a whole-file rewrite); rejected writes come back with compression instructions, the session loop brake force-lands repeated identical rejections, and a step-limit stop returns a PARTIAL card instead of failing. Also owns `writePlaybook` — the gated (triggered-bucket-only) mutation of a sub-agent's playbook |
| `previously-format.ts` | previously.md format — v3 archive (read-only history) + v5 user card (Identity / Past = profile paragraph + anchor facts / Now = agent-expired hooks / Horizon = future commitments with `by` dates); serialization, parsing, per-item caps, legacy migration. The old Self-model section is gone from the WRITER — patterns live in the direction Portrait now — but parseCard still reads it on legacy cards (the migration source) |
| `card-session.ts` | The mutation session behind the agent's write tools — in-memory CardDocument + per-entry validated mutations (`addNow` / `updatePastProfile` / `resolveHorizon` / …), loop brake (repeated identical rejections escalate → force-apply/skip), substance comparison. Pure, no I/O |
| `flash/backfill-marks.ts` | Opportunistic dry-slice remediation — on a close boundary, a sub-agent (main model via the shared runner) fills focus/summary for up to 3 `needs_marking` slices, inside the turn's batch |
| `timeline/` | Canonical catalog (`store.ts`: `timeline/index.json` + upsert), `weave.ts` projection reconcile ("slices are truth, timeline is a projection"), `render.ts` pointer lines (incl. `sliceLineWithTime`), `enumerate.ts` repo enumeration (default-branch aware) |
| `io-helpers.ts` | I/O wrappers delegating to demo-fs, GitHub API, or local FS. Batching is an EXPLICIT `WriteBatch` object (`createBatch()` → thread through I/O calls → `flushBatch(batch, msg)`) — never module-global, so concurrent turns in one process can't flush each other's writes. A failed flush keeps the queue for retry. Local-backend writes additionally record a best-effort git commit when the memory root is a git repo (see `local-git.ts`) |
| `local-git.ts` | Best-effort git ledger for the local backend (isomorphic-git, no git binary needed): bare `fsWriteFile` = one commit, `flushBatch` = one commit for the batch. The filesystem stays the source of truth — commit failures are warned and swallowed, and the layer is inert when the memory root has no `.git` |
| `slice-mutex.ts` | In-process per-sliceId async mutex (`withSliceLock`) serializing housekeeping/finalizeTurn on the same slice; acquired inside a single step only |
| `turn-merge.ts` | `mergeTurnsWithRemote` — pure append-only turn merge used by finalizeTurn's write-conflict self-heal (re-read remote core.md, append missing turns by turnId, retry commit ≤ 2×) |
| `rework-signal.ts` | Mechanical-signal instrumentation (v1.0 design §2.6) — module-level per-conversation record of recall outcomes; classifies each main-agent `readSlice` as `verify` / `rework`, plus the UI-driven interaction signals (`interaction_regenerate`, recorded by housekeeping from the regenerate body flag; `interaction_interrupt`, POSTed to `/api/episodic/signal` when the user stops a turn). Every signal lands in BOTH the machine-readable fitness store and an audit line in the slice's agent.md. Best-effort — never fails the caller |
| `../evolution/` | Evolution data layer + loop (v1.0 design §2): `paths.ts` (file constants), `store.ts` (typed I/O over `memory/evolution/` + `memory/agent-playbooks/` — direction doc, per-sub-agent playbooks, generation-scoped fitness event/signal store with structural evidence-anchoring + the generation settle (`resetFitnessGeneration`), generation net scores), `triggers.ts` (deterministic trigger computation (v0.9.2): a bucket's current-generation net ≤ -5 fires it — purely quantitative, no semantic fast paths), `direction-agent.ts` (the direction contract — Portrait (six fixed dimensions) + hypothesis-pool skeleton, mode detection (bootstrap/migrate/steady), structural proposal validation, the L1b system-prompt layer builder; plus the legacy standalone evaluator) |

## Key Flows

### 1. Time slice lifecycle

1. **Create** — `createSlice()` in `manager.ts` is called when the chat route receives a message with no active slice (or after context loss/close). Derives `slice_id` from the UTC date+time of the first message (e.g. `2026-07-07-1558`), creates an in-memory `TimeSlice` with the first turn.
2. **Extend** — `appendTurn()` adds subsequent turns to the in-memory slice. `saveSliceSnapshot()` writes the slice to disk as a checkpoint every N turns and on `beforeunload`.
3. **Close** — Triggered by: slice age cap (30 min from slice start), context loss (page refresh / device switch), or turn count cap (safety net). `closeSlice()` sets `status: "closed"`, writes the MD file, updates `_index.json` and `strands.json`. The cycle repeats with a new slice.
4. **Recover** — `tryLoadTodaySlice()` scans today's directory (`slices/YYYY/MM/DD/`) and re-hydrates the most recent slice still marked `active` on page refresh.

### 2. Turn analyze (per turn, in housekeeping)

1. `housekeeping` first decides the slice lifecycle (pure — continue / close / create), then calls `analyzeTurn` (main model via the shared runner, thinking ON at low effort) ONCE with the user message + existing strand names + (when closing) the closing slice's turns.
2. The call returns: 0-5 message tags (reusing existing tags across languages), a semantic hint (which existing strands the message relates to), the user's intent, and — only when a slice is closing — its `focus` / `summary` / refined `tags` / `emotional_tone`.
3. The close marking is applied to the closing slice BEFORE `closeSlice` persists it, so the timeline and monthly index carry real descriptions.
4. Message tags are written to `slice.tags` and woven into `strands.json` via `updateStrands()` during the snapshot save.

### 3. Episodic state for the UI

1. `getEpisodicState()` (server action in `actions.ts`) scans monthly indices backward, returns the most recent slice as `active` plus up to 2 more as `recent`, plus a `hasMore` flag for pagination.
2. `getMoreSlices(before)` returns slices older than the given cursor, with cursor-based pagination.
3. `getSliceContent(sliceId)` reads the full MD file, parses turns, and returns structured content for the detail view.

### 4. Card evolution (every boundary, two-phase + explicit trigger)

1. The evolution runs INLINE in the housekeeping step (v0.7b). Engineering owns the TRIGGER only: the trigger is the deterministic fitness scoring (`computeEvolutionTriggers` — GENERATION semantics (v0.9.2): a bucket fires when its CURRENT-GENERATION net reaches -5, purely quantitative, no semantic fast paths) combined with the card bucket's legacy gates — the analyzer's `evolve_card.worth` judgment (failure defaults to true) and a legacy (pre-v5) card forcing a run. A SUCCESSFUL fitness-triggered run settles the generation (`resetFitnessGeneration` clears all buckets' events + signals — a "checked, no change" verdict included; a failed run settles nothing; non-fitness-gated runs never settle). No trigger and no card gate → NO evolution sub-agent runs. Explicit user requests — including behavioral corrections, not just "记住…" phrasing — are detected via `memory_update` and trigger an immediate (card-only) run — the INSTRUCTION channel, not selection pressure. Progress streams via `data-evolution` chunks.
1b. When a boundary triggers, evolution is ONE MERGED RUN (v1.1 — the old two-phase split is gone): the Previously Agent first evaluates `memory/evolution/direction.md` — the loop's USER PORTRAIT + HYPOTHESIS POOL (fixed skeleton: `# Portrait` with six fixed `##` dimensions — Traits & cognitive style / Triggers & rhythms / Patterns & loops / Strengths & resilience / Communication preferences / Values & boundaries — entries portrait-grade: cross-context, outliving their evidence, predictive; slice pointers only in trailing `— refs:` tails / `# Hypotheses`: a bounded dynamic pool of ≤10 trait-level guesses, confirmed → promoted into the Portrait in the same run, refuted → removed, unverified 4 slices → retired — the TTL enforced in code) — and moves it through ATOMIC direction mutation ops (`applyDirectionOps`; the doc is never rewritten wholesale); `runCardEvolution` then runs the whole-doc gate mode-aware (steady: ≥2 distinct slice pointers across the doc; bootstrap/migrate: ≥1) plus the TTL pass and writes via `writeDirection`. The card + triggered buckets' playbooks are then evolved under the possibly-new direction in the same run. The direction gate: MIGRATE (an old skeleton: # Direction / # Anti-goals, or the first portrait skeleton's # Evidence / # Log) is always due; BOOTSTRAP (never written) is due when material exists (legacy Self-model lines on the card, or any fitness events).
1c. Fitness deltas (the analyzer's Task 7, or the bridge report's `fitness` array) are persisted right after the analysis via `appendFitnessEvents` — the store force-zeroes evidence-less deltas structurally. There is NO mutation archive (v0.9.2): accepted writes land in the live documents only; evolution has no direction, so a mutation is never judged against its predecessor and nothing rolls back.
2. There is NO mechanical card pass: expiry/overdue/caps are the agent's decisions, enforced inside its write tools. Housekeeping computes overdue Horizon items read-only for turn priming and injects the time context (user-local date, Now ages) into the prompt.
3. The Previously Agent (main model via the shared runner, thinking on at low effort) edits an in-memory copy of the card through per-entry mutation tools (`addNow`, `updatePastProfile`, `resolveHorizon`, …). Over-limit / malformed writes are REJECTED with compression instructions — the agent decides what survives a cap; a loop brake escalates repeated identical rejections (2nd: exact arithmetic; 3rd: force-apply truncated for length violations, skip + finish-now otherwise). A pass that hits the step cap without `finish` returns a PARTIAL card (mutations kept, note flagged) instead of failing. It normally ends with a `finish` call.
4. The serialized result is written back only when the card's substance changed (stamps ignored) — both the live card and the per-slice snapshot.

## Core Types

All defined in `types.ts` unless noted.

| Type | Key Fields |
|------|------------|
| `TimeSlice` | `slice_id`, `focus`, `status` (active/closed), `start`/`end`, `turns: Turn[]`, `estimatedTokens`, `closedBy: SlicingSignal`, optional `continuesFrom` (checkpoint link) |
| `Turn` | `timestamp` (ISO 8601), `role` ("user"/"agent"), `content`, optional `turnId` (6-char base64url) |
| `SliceFrontmatter` | The YAML representation of a slice: adds `summary`, `open_loops`, `decisions`, `tags`, `related_slices`, `emotional_tone`, `continues_from` |
| `SlicingSignal` | `"time_cap" \| "time_silence" (legacy) \| "user_explicit" \| "capacity" \| "context_lost" \| "idle_gap"` |
| `SliceIndexEntry` | Slim version stored in `_index.json`: `id`, `focus`, `summary`, `tags`, `status`, `start`, `open_loops`, `decisions` |
| `SliceSummary` (actions.ts) | Truncated view for UI: `slice_id`, `focus`, `summary`, `start`, `status`, `open_loops`, `decisions` |

## File Layout on Disk

```
memory/episodic/
  slices/
    YYYY/
      MM/
        DD/
          HHMM/
            timeline/
              core.md           -- time slice body (YAML frontmatter + turns)
              agent.md          -- agent cognition log (mechanical extraction)
            previously.md       -- user-card snapshot (Previously Agent evolution)
        _index.json             -- monthly index of all slices in this month
  strands.json                  -- the strand index: strand (keyword) -> slice paths
  timeline.md                   -- global timeline (all slice summaries)
```

The v1.0 evolution data layer (design §2, `src/lib/evolution/`) adds two more
locations OUTSIDE `memory/episodic/`:

```
memory/evolution/
  direction.md                  -- cross-slice user portrait + hypothesis pool (design §2.2)
  fitness.json                  -- bounded fitness events + mechanical signals (§2.5/§2.6)
memory/agent-playbooks/
  recall.md / search.md / thinkdeep.md   -- per-sub-agent evolved playbooks (§2.4)
```

**Strands.** A slice carries `tags` (keywords). A **strand** is a keyword woven
through all the slices that carry it — one entry in `strands.json` maps a strand
to its slice paths, i.e. "the whole history of that thing" across time. It's the
thin, lossless semantic-memory layer over the episodic slices. Tags are extracted
by the turn analyzer in the housekeeping step and woven into strands at snapshot time.

## Design Decisions

- **Tag extraction in housekeeping**: A quick low-effort sub-agent call (main model via the shared runner) extracts tags from each user message. Existing tags are preferred to encourage cross-language semantic merging (e.g., "self-evolution" and "自我进化" reuse the same tag).
- **Context continuity detection**: When a client has no assistant messages in its history but the recovered slice has agent turns, the slice is closed with `"context_lost"` — handling page refreshes and device switches gracefully.
- **Main agent reads only**: The main agent never modifies previously.md. The Previously Agent (main model via the shared runner) edits the card through validated mutation tools; mechanical writes (slice tags, strands) happen in housekeeping and finalizeTurn. Card evolution runs INLINE in the housekeeping step, gated by the analyzer's `evolve_card.worth` judgment (a legacy-format card forces a run).
- **Pure time-based slicing with idle-gap + context-loss triggers**: The primary slicing triggers are slice age (30 min from slice start, `"time_cap"`) and idle gap (15 min since the last turn, `"idle_gap"`), plus context loss (`"context_lost"`). Turn count cap is a pure safety net (`"capacity"`). `time_cap`/`capacity` are autosave CHECKPOINTS of the same conversation — the new slice links back via `continuesFrom` and carries the closed slice's last 10 turns as a frozen history prefix; `idle_gap`/`context_lost` are genuine conversation boundaries (no link, no carry-over). `"time_silence"` is a legacy `closed_by` value kept for historical slices.
- **In-memory active slice with periodic snapshots**: The slice is held in a module-level variable. It is snapshotted to disk periodically (every N turns, `beforeunload`) but not on every turn -- avoids excessive GitHub API writes. `tryLoadTodaySlice()` recovers state on refresh.
- **Gray-matter serialization**: Slices use `---` YAML frontmatter + markdown body, parsed via `gray-matter`. Turn headers follow the convention `## Turn {id} — ISO_TIMESTAMP (role)`.
- **Dual storage backend**: Local filesystem (dev) vs. GitHub API (production) selected at import time via a `USE_GITHUB` flag. The `fsReadFile`/`fsWriteFile`/`fsListFiles` wrappers in `io-helpers.ts` delegate transparently.
- **Demo mode extends scan range**: with the demo data source (`STORAGE=demo`), `actions.ts` scans up to 48 months back instead of 1-2, supporting pre-seeded demo personas.

## Known Limitations

- **Turn-header collision**: a message body containing a line shaped like `## Turn {id} — ISO (role)` splits slice parsing incorrectly (pinned by a guard test in `manager.test.ts`).
- **Rich first-class strands** (with per-strand rolling summaries) are a future milestone. Currently strands are a keyword-to-slice-paths index; the recall agent traces them automatically but they don't yet carry their own semantic summaries.
