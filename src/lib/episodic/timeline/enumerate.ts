/**
 * Backend-aware slice enumeration for the timeline weave.
 *
 * Returns the *actual* set of slice relative paths ("YYYY/MM/DD/HHMM") that
 * exist on disk / in the repo — the truth the projection is reconciled against.
 *
 * - GitHub: recursive Git Trees API — ONE call returns every path under the
 *   repo, so enumeration never costs N directory round-trips.
 * - Local / demo: recursive walk through the existing fsListFiles layer (which
 *   routes to local-fs or demo-fs).
 */
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { fsListFiles } from "../io-helpers";

const SLICES_ROOT = "memory/episodic/slices";

/** A slice relative path segment: "2026/08/11/1115". */
export const SLICE_PATH_RE = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/;

/** Enumerate all slice dirs under the whitelisted root. */
export async function enumerateSliceIds(): Promise<string[]> {
  if (resolveDataSource() === "github") return enumerateGithubTree();
  return enumerateViaList();
}

async function enumerateGithubTree(): Promise<string[]> {
  const { owner, repo } = getRepoConfig();
  const octokit = getOctokit();
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: "heads/main",
  });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref.object.sha,
    recursive: "1",
  });

  const ids: string[] = [];
  const prefix = `${SLICES_ROOT}/`;
  for (const item of tree.tree ?? []) {
    if (item.type !== "tree") continue;
    const p = item.path ?? "";
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (SLICE_PATH_RE.test(rel)) ids.push(rel);
  }
  return ids;
}

/** List a dir, returning [] when it doesn't exist (missing year/month/day). */
async function safeList(path: string): Promise<
  Array<{ name: string; type: "file" | "dir" }>
> {
  try {
    return await fsListFiles(path);
  } catch {
    return [];
  }
}

async function enumerateViaList(): Promise<string[]> {
  const ids: string[] = [];
  const isYear = (n: string) => /^\d{4}$/.test(n);
  const isPair = (n: string) => /^\d{2}$/.test(n);

  const years = await safeList(SLICES_ROOT);
  for (const y of years.filter((e) => e.type === "dir" && isYear(e.name))) {
    const months = await safeList(`${SLICES_ROOT}/${y.name}`);
    for (const mo of months.filter((e) => e.type === "dir" && isPair(e.name))) {
      const days = await safeList(`${SLICES_ROOT}/${y.name}/${mo.name}`);
      for (const d of days.filter((e) => e.type === "dir" && isPair(e.name))) {
        const slices = await safeList(`${SLICES_ROOT}/${y.name}/${mo.name}/${d.name}`);
        for (const s of slices.filter((e) => e.type === "dir" && /^\d{4}$/.test(e.name))) {
          ids.push(`${y.name}/${mo.name}/${d.name}/${s.name}`);
        }
      }
    }
  }
  return ids;
}
