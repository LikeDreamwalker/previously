/**
 * Best-effort git ledger for the LOCAL storage backend.
 *
 * Design principle: the filesystem is the source of truth. Writes land on
 * disk FIRST (via writeFileLocal); this layer records them in a git commit
 * AFTER the fact, purely as a best-effort audit ledger that aligns the local
 * backend with the GitHub backend's semantics (one bare write = one commit,
 * one batch flush = one commit). Any failure here is logged with console.warn
 * and swallowed — it must NEVER block, fail, or roll back a write.
 *
 * The repository root is the memory root (getMemoryRoot()), so `filepath`
 * values handed to isomorphic-git are memory-internal relative paths (e.g.
 * `episodic/strands.json`, `user/config.json`) in posix style. When the
 * memory root is not a git repo the whole layer is inert — zero behavior
 * change versus plain disk writes.
 *
 * Uses isomorphic-git (pure JS) so client-mode users get the ledger even on
 * machines without a git binary.
 */
import git from "isomorphic-git";
import fs, { existsSync } from "fs";
import { join } from "path";

const DEFAULT_AUTHOR_NAME = "Previously";
const DEFAULT_AUTHOR_EMAIL = "previously@localhost";

/**
 * Positive-only existence cache: a repo rarely stops being one mid-process,
 * while a negative result stays re-checkable (a user may `git init` their
 * memory root while the server is running).
 */
const repoCache = new Map<string, true>();

/** True when `root` contains a `.git` entry (directory or gitfile). */
export function isGitRepo(root: string): boolean {
  if (repoCache.has(root)) return true;
  let result = false;
  try {
    result = existsSync(join(root, ".git"));
  } catch {
    result = false;
  }
  if (result) repoCache.set(root, true);
  return result;
}

/**
 * Stage `relPaths` (relative to `root`, posix separators) and create one
 * commit with `message`. Returns true on success; on ANY error logs a
 * warning and returns false — the write already happened on disk, and the
 * ledger is best-effort.
 */
export async function commitPaths(
  root: string,
  relPaths: string[],
  message: string,
): Promise<boolean> {
  try {
    if (relPaths.length === 0) return false;
    const author = {
      name: process.env.PREVIOUSLY_GIT_AUTHOR_NAME || DEFAULT_AUTHOR_NAME,
      email: process.env.PREVIOUSLY_GIT_AUTHOR_EMAIL || DEFAULT_AUTHOR_EMAIL,
    };
    for (const rel of relPaths) {
      const filepath = rel.replace(/\\/g, "/");
      if (existsSync(join(root, rel))) {
        await git.add({ fs, dir: root, filepath });
      } else {
        // File vanished between write and commit — stage the removal.
        await git.remove({ fs, dir: root, filepath });
      }
    }
    await git.commit({ fs, dir: root, message, author });
    return true;
  } catch (err) {
    console.warn(
      `[local-git] commit failed for ${relPaths.join(", ")} (fs write already succeeded; ledger is best-effort):`,
      err,
    );
    return false;
  }
}
