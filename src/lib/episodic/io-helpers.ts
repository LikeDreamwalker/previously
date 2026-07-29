/**
 * Shared I/O helpers for the episodic memory subsystem.
 *
 * All file reads/writes/listing routes through these three functions, which
 * delegate to the correct backend based on environment:
 *   - Demo mode → demo-fs (remote benchmark data)
 *   - GitHub mode → GitHub API (production)
 *   - Otherwise   → local filesystem (dev)
 *
 * Batch mode: call `startBatch()` to begin collecting writes. Subsequent
 * `fsWriteFile` calls are queued in-memory instead of hitting the backend
 * immediately. `fsReadFile` checks the pending queue first, so writes that
 * happen earlier in the same batch are visible to later reads (preserving
 * ordering dependencies). Call `flushBatch(message)` to commit all queued
 * writes as a single git commit (GitHub mode) or write them to disk (local).
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

// ─── Batch state (module-level — single turn === single batch boundary) ──

/** Pending writes keyed by path. `null` means batch mode is off. */
let pendingWrites: Map<string, string> | null = null;

/** Begin collecting writes into a batch. */
export function startBatch(): void {
  pendingWrites = new Map();
}

/** True when batch mode is active (writes are being deferred). */
export function isBatching(): boolean {
  return pendingWrites !== null;
}

/**
 * Commit all queued writes as a single git commit and exit batch mode.
 * If the queue is empty this is a no-op.
 */
export async function flushBatch(message: string): Promise<void> {
  if (!pendingWrites || pendingWrites.size === 0) {
    pendingWrites = null;
    return;
  }

  const entries: BatchEntry[] = [];
  for (const [path, content] of pendingWrites) {
    entries.push({ path, content });
  }
  pendingWrites = null;

  if (DEMO_MODE) {
    for (const { path, content } of entries) {
      await writeFileDemo(path, content);
    }
    return;
  }

  if (USE_GITHUB) {
    await commitBatchToGitHub(entries, message);
    return;
  }

  // Local filesystem — no commit overhead, just write individually
  for (const { path, content } of entries) {
    await writeFileLocal(path, content);
  }
}

// ─── Public I/O helpers ─────────────────────────────────────────────────

export async function fsReadFile(path: string): Promise<string> {
  // During batch mode, check pending writes first so functions that write
  // and then read (e.g. write _index.json → generateGlobalTimeline reads it)
  // see the latest in-batch content.
  if (pendingWrites?.has(path)) {
    return pendingWrites.get(path)!;
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
): Promise<{ path: string; created: boolean }> {
  // In batch mode: queue the write, don't touch the backend yet.
  if (pendingWrites !== null) {
    pendingWrites.set(path, content);
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
