"use server";

import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import {
  UPSTREAM_REPO_OWNER,
  UPSTREAM_REPO_NAME,
  UPSTREAM_REPO_REF,
  GITHUB_RELEASES_API,
  shouldSyncPath,
} from "./constants";

// ── Types ──

export interface SyncResult {
  ok: boolean;
  /** Human-readable error message if ok is false. */
  error?: string;
  /** Number of code files synced. 0 means already up to date. */
  syncedFiles?: number;
  /** SHA of the created merge commit. */
  commitSha?: string;
  /** Upstream version tag synced to (e.g. "0.3.1"), or short SHA if unavailable. */
  upstreamVersion?: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

// ── Helpers ──

function isRateLimitError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === 403 || status === 429;
}

function isTokenScopeError(error: unknown): boolean {
  const msg = (error as { message?: string }).message ?? "";
  return (
    (error as { status?: number }).status === 403 &&
    msg.toLowerCase().includes("resource not accessible")
  );
}

// ── Main action ──

/**
 * Sync code files from the upstream template repository into the user's repo.
 *
 * Uses the Git Data API to construct a proper merge commit with two parents
 * (user's HEAD + upstream HEAD), preserving git history. Only code directories
 * and root config files are synced — user data in memory/, tasks/, sessions/
 * is never touched.
 *
 * Must be called from a client component. Requires GITHUB_TOKEN,
 * GITHUB_REPO_OWNER, and GITHUB_REPO_NAME environment variables.
 */
export async function syncFromUpstream(): Promise<SyncResult> {
  // ── 1. Validate environment ──
  const { owner, repo } = getRepoConfig();

  if (owner === "local" || repo === "local") {
    return {
      ok: false,
      error:
        "Repository not configured. Set GITHUB_REPO_OWNER and GITHUB_REPO_NAME environment variables.",
    };
  }

  let octokit;
  try {
    octokit = getOctokit();
  } catch (e) {
    return {
      ok: false,
      error:
        "GitHub token not configured. Set the GITHUB_TOKEN environment variable.",
    };
  }

  // ── 2. Get upstream HEAD ──
  let upstreamSha: string;
  try {
    const ref = await octokit.rest.git.getRef({
      owner: UPSTREAM_REPO_OWNER,
      repo: UPSTREAM_REPO_NAME,
      ref: UPSTREAM_REPO_REF,
    });
    upstreamSha = ref.data.object.sha;
  } catch (e) {
    if (isRateLimitError(e)) {
      return {
        ok: false,
        error: "GitHub API rate limit reached. Please wait and try again.",
      };
    }
    return {
      ok: false,
      error: "Could not reach the upstream repository. Please try again later.",
    };
  }

  // ── 3. Get upstream tree (recursive) ──
  let upstreamTree: TreeEntry[];
  try {
    const tree = await octokit.rest.git.getTree({
      owner: UPSTREAM_REPO_OWNER,
      repo: UPSTREAM_REPO_NAME,
      tree_sha: upstreamSha,
      recursive: "1",
    });
    upstreamTree = tree.data.tree as TreeEntry[];
  } catch (e) {
    return {
      ok: false,
      error: "Could not read the upstream file tree. Please try again later.",
    };
  }

  // ── 4. Get user HEAD ──
  let userHeadSha: string;
  try {
    const ref = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: "heads/main",
    });
    userHeadSha = ref.data.object.sha;
  } catch (e) {
    return {
      ok: false,
      error: "Could not read your repository state. Check your GitHub token permissions.",
    };
  }

  // ── 5. Fetch upstream version (best-effort, for commit message) ──
  let upstreamVersion: string | null = null;
  try {
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      upstreamVersion = data.tag_name?.replace(/^v/, "") ?? null;
    }
  } catch {
    // best-effort — fall back to short SHA
  }
  const upstreamLabel = upstreamVersion ?? upstreamSha.slice(0, 7);

  // ── 6. Filter tree entries ──
  const syncEntries = upstreamTree.filter(
    (entry) => entry.type === "blob" && shouldSyncPath(entry.path),
  );

  if (syncEntries.length === 0) {
    return {
      ok: false,
      error: "No matching files found in the upstream repository.",
    };
  }

  // ── 7. Fetch user's HEAD tree (required — needed for data preservation) ──
  let userTreeEntries: TreeEntry[];
  try {
    const userCommit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: userHeadSha,
    });
    const userTree = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: userCommit.data.tree.sha,
      recursive: "1",
    });
    userTreeEntries = userTree.data.tree as TreeEntry[];
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not read your repository state. Check your GitHub token permissions.",
    };
  }

  // ── 7b. No-op check: compare blob SHAs ──
  const userBlobMap = new Map<string, string>();
  for (const entry of userTreeEntries) {
    if (entry.type === "blob" && entry.path && entry.sha) {
      userBlobMap.set(entry.path, entry.sha);
    }
  }

  const allMatch = syncEntries.every(
    (entry) => userBlobMap.get(entry.path) === entry.sha,
  );

  if (allMatch) {
    return {
      ok: true,
      syncedFiles: 0,
      upstreamVersion: upstreamVersion ?? undefined,
    };
  }

  // ── 7c. Collect user data entries to preserve ──
  // These are files in memory/, tasks/, sessions/ that exist in the user's
  // repo but not in the upstream tree. We MUST include them in the new tree
  // so the merge commit doesn't delete them.
  const preserveEntries: Array<{ path: string; sha: string }> = [];
  for (const entry of userTreeEntries) {
    if (entry.type === "blob" && entry.path && entry.sha) {
      // Only preserve entries in excluded directories (user data)
      // Code files will be replaced by upstream versions
      if (!shouldSyncPath(entry.path)) {
        preserveEntries.push({ path: entry.path, sha: entry.sha });
      }
    }
  }

  // ── 8. Create blobs in user's repo (upstream code files only) ──
  const blobs: Array<{ path: string; sha: string }> = [];
  const failedPaths: string[] = [];

  for (const entry of syncEntries) {
    try {
      // Get blob content from upstream
      const upstreamBlob = await octokit.rest.git.getBlob({
        owner: UPSTREAM_REPO_OWNER,
        repo: UPSTREAM_REPO_NAME,
        file_sha: entry.sha,
      });

      const content = Buffer.from(upstreamBlob.data.content, "base64").toString(
        "utf-8",
      );

      // Create blob in user's repo
      const newBlob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content,
        encoding: "utf-8",
      });

      blobs.push({ path: entry.path, sha: newBlob.data.sha });
    } catch (e) {
      failedPaths.push(entry.path);
      // Continue with remaining files unless it's a hard error
      if (isRateLimitError(e)) {
        return {
          ok: false,
          error: `GitHub API rate limit reached after syncing ${blobs.length} files. Please wait and try again.`,
        };
      }
    }
  }

  // If more than half failed, abort
  if (failedPaths.length > 0 && failedPaths.length > syncEntries.length / 2) {
    return {
      ok: false,
      error: `Failed to sync ${failedPaths.length} of ${syncEntries.length} files. Check your GitHub token permissions.`,
    };
  }

  if (blobs.length === 0) {
    return {
      ok: false,
      error: "No files could be synced. Check your GitHub token permissions.",
    };
  }

  // ── 8b. Merge upstream code blobs with preserved user data entries ──
  // The final tree must contain both: upstream code files (new blobs) AND
  // user data files (existing SHAs from the user's tree). Without this step,
  // the merge commit would delete all user data.
  const allTreeEntries = [
    ...blobs,                                          // upstream code (new SHAs)
    ...preserveEntries.filter(                         // user data (existing SHAs)
      (p) => !blobs.some((b) => b.path === p.path),   // avoid duplicates
    ),
  ];

  // ── 9. Build tree in user's repo ──
  let newTreeSha: string;
  try {
    const newTree = await octokit.rest.git.createTree({
      owner,
      repo,
      tree: allTreeEntries.map((b) => ({
        path: b.path,
        mode: "100644",
        type: "blob",
        sha: b.sha,
      })),
    });
    newTreeSha = newTree.data.sha;
  } catch (e) {
    return {
      ok: false,
      error: `Failed to build the file tree. ${e instanceof Error ? e.message : ""}`,
    };
  }

  // ── 10. Create merge commit (two parents) ──
  const commitMessage = `Merge upstream (Previously v${upstreamLabel})

Synced ${blobs.length} files from ${UPSTREAM_REPO_OWNER}/${UPSTREAM_REPO_NAME}@main.

Upstream: ${upstreamSha.slice(0, 7)}
Source: https://github.com/${UPSTREAM_REPO_OWNER}/${UPSTREAM_REPO_NAME}`;

  let newCommitSha: string;
  try {
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: newTreeSha,
      parents: [userHeadSha, upstreamSha],
    });
    newCommitSha = commit.data.sha;
  } catch (e) {
    if (isTokenScopeError(e)) {
      return {
        ok: false,
        error:
          "Your GitHub token does not have permission to write to this repository. Make sure the token has Contents read/write scope.",
      };
    }
    return {
      ok: false,
      error: `Failed to create the sync commit. ${e instanceof Error ? e.message : ""}`,
    };
  }

  // ── 11. Update branch ref ──
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: "heads/main",
      sha: newCommitSha,
      force: false, // safe — fails if someone else pushed between our read and write
    });
  } catch (e) {
    return {
      ok: false,
      error:
        "Failed to update your repository. Your main branch may have changed during the sync — please try again.",
    };
  }

  return {
    ok: true,
    syncedFiles: blobs.length,
    commitSha: newCommitSha,
    upstreamVersion: upstreamVersion ?? undefined,
  };
}
