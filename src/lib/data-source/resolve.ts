/**
 * Data-source resolution — decides where memory reads & writes land.
 *
 * Controlled by the STORAGE environment variable:
 *
 *   STORAGE=local   → local filesystem (dev, full read/write)
 *   STORAGE=github  → GitHub API via Octokit (production, full read/write)
 *   STORAGE=demo    → remote benchmark data (read-only, persona-based)
 *
 * When STORAGE is NOT set, auto-detection:
 *
 *   GITHUB_TOKEN present  → "github"
 *   NODE_ENV=development  → "local"
 *   otherwise             → "demo"
 *
 * The rest of the codebase imports from here or from capabilities.ts
 * (which delegates here). No other module reads process.env for data-source
 * decisions — this is the single source of truth.
 */

export type DataSource = "local" | "github" | "demo";

/**
 * The effective data source for this deployment.
 *
 * Explicit STORAGE env var takes priority. When unset, auto-detection
 * derives the source from GITHUB_TOKEN / NODE_ENV presence.
 */
export function resolveDataSource(): DataSource {
  // Explicit override — highest priority
  const explicit = process.env.STORAGE;
  if (explicit === "local" || explicit === "github" || explicit === "demo") {
    return explicit;
  }

  // Auto-detection
  if (process.env.GITHUB_TOKEN) return "github";
  if (process.env.NODE_ENV === "development") return "local";
  return "demo";
}

/** Shortcut: are we currently in demo mode? */
export function isDemo(source?: DataSource): boolean {
  return (source ?? resolveDataSource()) === "demo";
}

/** Shortcut: can we write? Demo is read-only. */
export function isWritable(source?: DataSource): boolean {
  const s = source ?? resolveDataSource();
  return s === "local" || s === "github";
}
