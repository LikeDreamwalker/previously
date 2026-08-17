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
 * them to disk (local). Because the batch is a per-call object — not a module
 * global — two turns running concurrently in one process can never flush each
 * other's writes.
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
 * Commit all queued writes as a single git commit.
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

  // Local filesystem — no commit overhead, just write individually
  for (const { path, content } of entries) {
    await writeFileLocal(path, content);
  }
  batch.entries.clear();
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
  return writeFileLocal(path, content);
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
