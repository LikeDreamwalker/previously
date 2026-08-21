/**
 * Current app version. Single source of truth — DO NOT edit by hand.
 * Bumped automatically by the OpenFlow release flow on every release.
 */
export const APP_VERSION = "0.8.0";

export const GITHUB_RELEASES_API =
  "https://api.github.com/repos/previously-lab/agent/releases/latest";

// ── Upstream identity (for sync) ──

export const UPSTREAM_REPO_OWNER = "previously-lab";
export const UPSTREAM_REPO_NAME = "agent";
export const UPSTREAM_REPO_REF = "heads/main";

// ── Sync path configuration ──
// Directories whose entire contents are synced from upstream.
// "memory/", "tasks/", "sessions/" are intentionally excluded — they hold user data.
export const SYNC_CODE_DIRS = [
  "src/",
  "public/",
  "messages/",
  "scripts/",
  "config/",
  "tests/",
  "identity/",
  ".github/",
] as const;

// Individual root files to sync (not inside any of the synced directories).
export const SYNC_ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "next.config.ts",
  "tsconfig.json",
  "components.json",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "vercel.json",
  "vitest.config.mts",
  "playwright.config.ts",
  "LICENSE",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".gitignore",
] as const;

// Paths that must NEVER be synced, even if they appear in the upstream tree.
// Belt-and-suspenders: these are in .gitignore or are user-data directories.
export const SYNC_EXCLUDES = ["memory/", "tasks/", "sessions/"] as const;

// ── Semver utilities (hand-rolled, no dependency) ──

/** Parse a semver string into [major, minor, patch], or null if invalid. */
export function parseSemver(v: string): [number, number, number] | null {
  const parts = v.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts as [number, number, number];
}

/**
 * Compare two semver strings.
 * Returns positive if a > b, negative if a < b, 0 if equal or either is invalid.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// ── Sync path filter ──

/**
 * Returns true if a tree entry path should be synced from upstream.
 * Matches against SYNC_CODE_DIRS prefixes and SYNC_ROOT_FILES exact names,
 * and excludes SYNC_EXCLUDES prefixes.
 */
export function shouldSyncPath(path: string): boolean {
  // Normalize: strip leading slash, handle backslashes
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");

  // Excluded paths (user data directories)
  for (const exclude of SYNC_EXCLUDES) {
    if (normalized.startsWith(exclude)) return false;
  }

  // Code directories
  for (const dir of SYNC_CODE_DIRS) {
    if (normalized.startsWith(dir)) return true;
  }

  // Root files (exact match — no directory prefix)
  for (const file of SYNC_ROOT_FILES) {
    if (normalized === file) return true;
  }

  return false;
}
