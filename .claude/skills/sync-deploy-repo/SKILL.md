---
name: sync-deploy-repo
description: Sync code changes (fixes/releases) from this repo (Aftrbrez, previously-lab/agent) into the self-deployment repo at C:\Users\Dream\Documents\GitHub\agent (LikeDreamwalker/agent). Use when the user asks to sync/port/bring changes "到部署仓库/agent 仓库" — covers the cherry-pick workflow, the APP_VERSION rule, and the live-repo hazards.
---

# Sync changes to the deployment repo (`../agent`)

## The two repos

- **Source (this repo)**: `C:/Users/Dream/Documents/GitHub/Aftrbrez`, GitHub `previously-lab/agent`. Code + releases are authored here.
- **Target (deployment)**: `C:/Users/Dream/Documents/GitHub/agent`, GitHub `LikeDreamwalker/agent`. The user's own Vercel deployment. It has this repo registered as the `aftrbrez` remote.

## Why cherry-pick, never merge/rebase

The target's `main` is NOT a descendant of our `main`:

- Its code commits are **hash-rewritten cherry-pick copies** of ours (same messages, different hashes — e.g. our `917592ef` is their `83625559`).
- Its history is interleaved with **live data commits** (`Turn xxx — housekeeping/agent response`) produced by the running deployment.

So merging/rebasing our branch into theirs would duplicate the entire history. Sync = **cherry-pick the specific commits**.

## Procedure

1. `cd /c/Users/Dream/Documents/GitHub/agent && git fetch aftrbrez && git fetch origin`
2. Inspect what would move: `git log --oneline main..aftrbrez/<branch>` — confirm each commit should travel (skip version-bump-only commits like `chore: bump version`, see the APP_VERSION rule below).
3. `git cherry-pick <sha>...` onto their `main`.
4. Resolve conflicts — their code may lag ours by a few commits, so context can differ. For `src/lib/version/constants.ts` conflicts: **always keep THEIR version line** (see below).
5. Verify in the target repo: `npx vitest run <affected tests>` and `pnpm lint` (their node_modules is independent; it exists and works).
6. Push only after the user confirms — or leave it: the repo's live automation pulls/pushes `origin/main` on its own.

## APP_VERSION is OpenFlow-managed — never move it

`src/lib/version/constants.ts` is bumped automatically by the OpenFlow release flow on every release. Rules:

- **Never hand-edit `APP_VERSION`** in either repo — not as part of a fix, not during conflict resolution.
- When a cherry-picked commit touches that line, resolve the conflict by **keeping the target repo's existing value**.
- If a manual bump ever lands on the target by accident, restore it with a **new** commit (the target is a live repo, see below — do not rewrite history there).

## The target repo is LIVE — expect concurrent activity

An automated process continuously pulls and pushes `origin/main` in the target repo (data commits land every few minutes). Consequences:

- **Fetch first**, and assume anything may already be published. Before rewriting/amending any commit, check `git merge-base --is-ancestor <sha> origin/main` — if it's an ancestor, it is published; use a new fixup commit instead of an amend/reset.
- A `git pull` by the live process can land between your commands; always re-read `git log`/`git status` before continuing a multi-step operation.
- Never `git push --force` there.

## Notes

- `doc/` is gitignored in both repos — changelogs/release notes do not travel and don't need to.
- Data directories (`memory/`, `tasks/`, `sessions/`) belong to the target repo — never touch them from a sync.
- After syncing a demo-related change: the OFFICIAL demo needs `DEMO_LOCK=1` in its env; the self-deployment (github data source) is unaffected by the lock.
