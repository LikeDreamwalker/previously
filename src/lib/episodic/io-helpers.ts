/**
 * Shared I/O helpers for the episodic memory subsystem.
 *
 * All file reads/writes/listing routes through these three functions, which
 * delegate to the correct backend based on environment:
 *   - Demo mode → demo-fs (remote benchmark data)
 *   - GitHub mode → GitHub API (production)
 *   - Otherwise   → local filesystem (dev)
 *
 * Batch mode: a `WriteBatch` is an EXPLICIT object (`createBatch()`) that the
 * owning step threads through every I/O call in its write window. Passing the
 * batch to `fsWriteFile` queues the write in-memory instead of hitting the
 * backend; passing it to `fsReadFile` checks the pending queue first, so
 * writes earlier in the same batch are visible to later reads (read-your-
 * writes, preserving ordering dependencies). `flushBatch(batch, message)`
 * commits all queued writes as a single git commit (GitHub mode) or writes
 * them to disk and records one best-effort git commit when the memory root
 * is a git repo (local — see local-git.ts). Because the batch is a per-call
 * object — not a module global — two turns running concurrently in one
 * process can never flush each other's writes.
 *
 * Extracted from manager.ts to avoid circular imports: global-timeline.ts and
 * recall.ts need these helpers, but importing them from manager.ts would create
 * a cycle when manager.ts itself needs to call generateGlobalTimeline.
 */
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { listFiles as listFilesGitHub } from "@/lib/tools/listFiles";
import { commitBatchToGitHub, type BatchEntry } from "@/lib/tools/batch-write";
import {
  readFileLocal,
  writeFileLocal,
  listFilesLocal,
} from "@/lib/tools/local-fs";
import {
  readFileDemo,
  listFilesDemo,
  writeFileDemo,
} from "@/lib/demo/demo-fs";
import { resolveDataSource, isDemo } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import { getMemoryRoot } from "@/lib/whitelist";
import { commitPaths, isGitRepo } from "./local-git";

// ─── Environment detection ───────────────────────────────────────────────

const DATA_SOURCE = resolveDataSource();
const USE_GITHUB = DATA_SOURCE === "github";
const DEMO_MODE = isDemo(DATA_SOURCE);

// ─── Write batches (explicit, per-turn objects) ──────────────────────────

/**
 * A pending-writes batch. `entries` is mutable so a caller can adjust a
 * queued write before flushing (e.g. the finalize-turn conflict self-heal,
 * which replaces a stale slice file with a re-merged one before retrying).
 */
export interface WriteBatch {
  readonly entries: Map<string, string>;
}

/** Begin collecting writes into a fresh batch. */
export function createBatch(): WriteBatch {
  return { entries: new Map() };
}

/**
 * Commit all queued writes as a single git commit (GitHub mode; local mode
 * writes to disk and records one best-effort commit via local-git when the
 * memory root is a git repo).
 * If the queue is empty this is a no-op.
 *
 * On SUCCESS the batch is emptied. On FAILURE the entries are kept, so the
 * caller can inspect/adjust the queue and retry the flush (see finalizeTurn's
 * write-conflict self-heal).
 */
export async function flushBatch(
  batch: WriteBatch,
  message: string,
): Promise<void> {
  if (batch.entries.size === 0) return;

  const entries: BatchEntry[] = [];
  for (const [path, content] of batch.entries) {
    entries.push({ path, content });
  }

  if (DEMO_MODE) {
    for (const { path, content } of entries) {
      await writeFileDemo(path, content);
    }
    batch.entries.clear();
    return;
  }

  if (USE_GITHUB) {
    await commitBatchToGitHub(entries, message);
    batch.entries.clear();
    return;
  }

  // Local filesystem — write individually, then record one git commit for
  // the whole batch (mirrors the GitHub backend's N-files-1-commit batch).
  for (const { path, content } of entries) {
    await writeFileLocal(path, content);
  }
  batch.entries.clear();
  await commitLocalWrites(
    entries.map((e) => e.path),
    message,
  );
}

/**
 * Best-effort git ledger for local-backend writes. Only commits when the
 * memory root is itself a git repo; otherwise this is a no-op and local
 * writes behave exactly as before. `paths` are whitelisted app paths
 * (`memory/...`); the ledger repo root is the memory root, so the `memory/`
 * prefix is stripped to get repo-relative paths. Non-memory paths (tasks/,
 * sessions/) live outside the memory repo and are skipped. Never throws —
 * see local-git.ts.
 */
async function commitLocalWrites(paths: string[], message: string): Promise<void> {
  const root = getMemoryRoot();
  if (!isGitRepo(root)) return;
  const relPaths: string[] = [];
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/");
    if (normalized.startsWith("memory/")) {
      relPaths.push(normalized.slice("memory/".length));
    }
  }
  if (relPaths.length === 0) return;
  await commitPaths(root, relPaths, message);
}

// ─── Public I/O helpers ─────────────────────────────────────────────────

export async function fsReadFile(
  path: string,
  batch?: WriteBatch,
): Promise<string> {
  // With a batch, check pending writes first so functions that write and then
  // read (e.g. write _index.json → generateGlobalTimeline reads it) see the
  // latest in-batch content.
  const pending = batch?.entries.get(path);
  if (pending !== undefined) {
    return pending;
  }

  if (DEMO_MODE) return readFileDemo(path);
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return readFileGitHub(path, repo, owner);
  }
  return readFileLocal(path);
}

export async function fsWriteFile(
  path: string,
  content: string,
  batch?: WriteBatch,
): Promise<{ path: string; created: boolean }> {
  // With a batch: queue the write, don't touch the backend yet.
  if (batch) {
    batch.entries.set(path, content);
    return { path, created: true };
  }

  if (DEMO_MODE) return writeFileDemo(path, content);
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return writeFileGitHub(path, content, repo, owner);
  }
  const result = await writeFileLocal(path, content);
  // Mirror the GitHub backend's one-write-one-commit ledger (best-effort,
  // no-op unless the memory root is a git repo).
  await commitLocalWrites([path], `Update ${path.replace(/\\/g, "/").replace(/^memory\//, "")}`);
  return result;
}

export async function fsListFiles(
  path: string,
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  if (DEMO_MODE) return listFilesDemo(path);
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return listFilesGitHub(path, repo, owner);
  }
  return listFilesLocal(path);
}
