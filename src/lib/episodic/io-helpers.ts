/**
 * Shared I/O helpers for the episodic memory subsystem.
 *
 * All file reads/writes/listing routes through these three functions, which
 * delegate to the correct backend based on environment:
 *   - Demo mode → demo-fs (remote benchmark data)
 *   - GitHub mode → GitHub API (production)
 *   - Otherwise   → local filesystem (dev)
 *
 * Extracted from manager.ts to avoid circular imports: global-timeline.ts and
 * recall.ts need these helpers, but importing them from manager.ts would create
 * a cycle when manager.ts itself needs to call generateGlobalTimeline.
 */
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { listFiles as listFilesGitHub } from "@/lib/tools/listFiles";
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

// ─── Public I/O helpers ─────────────────────────────────────────────────

export async function fsReadFile(path: string): Promise<string> {
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
