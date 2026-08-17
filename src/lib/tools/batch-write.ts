/**
 * Batch GitHub writes — N file changes → 1 commit.
 *
 * Used by the episodic I/O layer during batch mode. Instead of calling
 * `createOrUpdateFileContents` once per file (each creates its own commit),
 * we use the Git Data API directly: create blobs, build a tree inheriting
 * from the current HEAD tree, create a single commit, and update the ref.
 *
 * This is the same pattern as `syncFromUpstream` but generalised for
 * arbitrary multi-file writes.
 */
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { invalidateReadCache } from "@/lib/tools/readFile";

export interface BatchEntry {
  path: string;
  content: string;
}

// ─── Default branch resolution (cached per process) ─────────────────────

let defaultBranchCache: { key: string; branch: string } | null = null;

/**
 * The repo's default branch (usually "main", but not always — the old code
 * hardcoded `heads/main` and broke on repos whose default branch differs).
 * Resolved once per process via repos.get and cached.
 */
async function resolveDefaultBranch(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
): Promise<string> {
  const key = `${owner}/${repo}`;
  if (defaultBranchCache?.key === key) return defaultBranchCache.branch;
  const { data } = await octokit.rest.repos.get({ owner, repo });
  const branch = data.default_branch || "main";
  defaultBranchCache = { key, branch };
  return branch;
}

/** Test-only: drop the cached default branch. */
export function _resetDefaultBranchCache(): void {
  defaultBranchCache = null;
}

/** The configured repo's default branch (cached per process). */
export async function getDefaultBranch(): Promise<string> {
  const { owner, repo } = getRepoConfig();
  return resolveDefaultBranch(getOctokit(), owner, repo);
}

/**
 * True when a commit failed because the ref moved under us (non-fast-forward
 * updateRef) — the signal for the caller to re-read, merge, and retry.
 */
export function isRefConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (/not a fast.?forward/i.test(message)) return true;
  // GitHub returns 422 for a rejected ref update, 409 for some race shapes.
  return e.status === 422 || e.status === 409;
}

/**
 * Commit multiple file changes as a SINGLE git commit via the Git Data API.
 * Uses `base_tree` so only the changed files are included — the new tree
 * inherits everything else from the current HEAD.
 *
 * Returns the new commit SHA. Throws on failure (caller should retry).
 */
export async function commitBatchToGitHub(
  entries: BatchEntry[],
  message: string,
): Promise<string> {
  const { owner, repo } = getRepoConfig();
  const octokit = getOctokit();
  const branch = await resolveDefaultBranch(octokit, owner, repo);
  const headRef = `heads/${branch}`;

  // 1. Get current HEAD
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: headRef,
  });
  const headSha = ref.object.sha;

  // 2. Get HEAD tree SHA (used as base_tree)
  const { data: commit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: headSha,
  });
  const baseTree = commit.tree.sha;

  // 3. Create blobs for each file
  const treeItems = await Promise.all(
    entries.map(async ({ path, content }) => {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content,
        encoding: "utf-8",
      });
      return {
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  // 4. Create new tree (inherits unchanged files from base_tree)
  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTree,
    tree: treeItems,
  });

  // 5. Create commit
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [headSha],
  });

  // 6. Update ref (fast-forward only — fails if someone else pushed)
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: headRef,
    sha: newCommit.sha,
    force: false,
  });

  // All written files changed on GitHub — drop them from the read cache so a
  // later read in this turn (or the next request) never serves stale content.
  for (const { path } of entries) {
    invalidateReadCache(path, repo, owner);
  }

  return newCommit.sha;
}
