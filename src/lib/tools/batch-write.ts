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

  // 1. Get current HEAD
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: "heads/main",
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
    ref: "heads/main",
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
