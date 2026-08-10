import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB limit for MVP

// ─── Read cache ──────────────────────────────────────────────────────────
//
// A per-instance TTL cache for GitHub `getContent` reads. A single chat turn
// reads several files repeatedly (strands.json 4-7x, current-previously.md
// 1-3x, monthly _index.json across generateGlobalTimeline's 2-3 rebuilds), and
// every read was a fresh GitHub API round-trip. This collapses those to one
// real request.
//
// Correctness contract:
// - GitHub-mode only by construction (this module IS the GitHub backend;
//   local/demo reads go through readFileLocal/readFileDemo).
// - Only successful reads are cached; 404s and errors never are (so a "file
//   doesn't exist yet, then it's created" flow can't serve a stale negative).
// - Writes invalidate the path: writeFile (single-file) and
//   commitBatchToGitHub (batched) both call invalidateReadCache, so a file the
//   agent just wrote is never served stale. io-helpers.fsReadFile checks its
//   pendingWrites queue BEFORE the cache, so in-batch write-then-read still
//   sees the freshest content.
// - TTL bounds cross-request staleness on multi-instance serverless where a
//   write lands on a different instance than this cache.
//
// NOTE: the key intentionally omits `ref` — the ref param is not wired into
// the getContent request today. If ref is ever used, add it to the key too.

const CACHE_TTL_MS = 60_000;

type CacheEntry = { content: string; at: number };

const readCache = new Map<string, CacheEntry>();

function cacheKey(owner: string, repo: string, path: string): string {
  return `${owner}/${repo}/${path}`;
}

function readCached(key: string): string | undefined {
  const hit = readCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    readCache.delete(key);
    return undefined;
  }
  return hit.content;
}

function writeCached(key: string, content: string): void {
  readCache.set(key, { content, at: Date.now() });
}

/** Drop a single path from the read cache (called after a GitHub write). */
export function invalidateReadCache(
  path: string,
  repo: string,
  owner: string,
): void {
  readCache.delete(cacheKey(owner, repo, path));
}

/** Clear the whole cache — used by tests for isolation. */
export function __resetReadCache(): void {
  readCache.clear();
}

/**
 * Read a file from the GitHub repository.
 * Only paths under the allowed directories are accessible.
 */
export async function readFile(
  path: string,
  repo: string,
  owner: string,
  ref?: string
): Promise<string> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`
    );
  }

  const key = cacheKey(owner, repo, path);
  const cached = readCached(key);
  if (cached !== undefined) return cached;

  const octokit = getOctokit();

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
    });

    // GitHub returns an array for directories, single object for files
    if (Array.isArray(response.data)) {
      throw new Error(`"${path}" is a directory, not a file`);
    }

    // Must be a regular file (not symlink or submodule)
    if (response.data.type !== "file") {
      throw new Error(`"${path}" is not a regular file (type: ${response.data.type})`);
    }

    // Check file size before decoding
    if (response.data.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File "${path}" is too large (${response.data.size} bytes). Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    // Content is base64-encoded
    const content = response.data.content
      ? Buffer.from(response.data.content, "base64").toString("utf-8")
      : "";

    writeCached(key, content);
    return content;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Access denied")) {
      throw error;
    }
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      throw new Error(`File not found: "${path}"`);
    }
    throw new Error(
      `Failed to read "${path}": ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}
