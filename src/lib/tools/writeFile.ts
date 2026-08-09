import { getOctokit } from "@/lib/github/client";
import { isPathAllowed } from "@/lib/whitelist";
import { invalidateReadCache } from "@/lib/tools/readFile";

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB limit for MVP

/**
 * Create or update a file in the GitHub repository.
 * Only paths under the allowed directories are writable.
 */
export async function writeFile(
  path: string,
  content: string,
  repo: string,
  owner: string,
  message?: string
): Promise<{ path: string; created: boolean }> {
  if (!isPathAllowed(path)) {
    throw new Error(
      `Access denied: path "${path}" is outside allowed directories`
    );
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Content is too large (${Buffer.byteLength(content, "utf-8")} bytes). Maximum is ${MAX_FILE_SIZE_BYTES} bytes.`
    );
  }

  const octokit = getOctokit();

  try {
    let sha: string | undefined;

    // Check if file already exists (to get SHA for update)
    try {
      const existing = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });
      if (!Array.isArray(existing.data)) {
        sha = existing.data.sha;
      }
    } catch {
      // File doesn't exist — that's fine, we'll create it
    }

    const commitMessage = message ?? `Update ${path}`;

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: commitMessage,
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
    });

    // The file just changed on GitHub — drop it from the read cache so a
    // subsequent read (same turn or next request) never serves stale content.
    invalidateReadCache(path, repo, owner);

    return { path, created: !sha };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Access denied")) {
      throw error;
    }
    throw new Error(
      `Failed to write "${path}": ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}
