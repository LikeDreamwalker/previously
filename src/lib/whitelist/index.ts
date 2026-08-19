import { join, isAbsolute } from "path";

/**
 * Allowed path prefixes for agent file operations.
 * Agents may only read/write files under these directories.
 * src/ is agent-read-only — no tool may modify it.
 */
const ALLOWED_PATHS = ["memory/", "tasks/", "sessions/"] as const;

/**
 * Absolute filesystem root for the `memory/` data directory.
 *
 * Configured via the MEMORY_ROOT environment variable (must be an absolute
 * path) — this is how client mode points the kernel at a data repo outside
 * the code repo (doc/design/v0.9-client.md §3.4). When unset, memory data
 * lives in the repo's own `memory/` directory, exactly as before.
 *
 * Throws when MEMORY_ROOT is set but not absolute — a silently ignored
 * misconfiguration would look like missing data.
 */
export function getMemoryRoot(): string {
  const configured = process.env.MEMORY_ROOT;
  if (!configured) {
    return join(process.cwd(), "memory");
  }
  if (!isAbsolute(configured)) {
    throw new Error(
      `MEMORY_ROOT must be an absolute path, got: "${configured}"`
    );
  }
  return configured;
}

/**
 * Resolve a whitelisted relative path to an absolute filesystem path for
 * local (non-GitHub) storage. `memory/` paths re-root at MEMORY_ROOT when
 * configured; everything else stays relative to the repo root. When
 * MEMORY_ROOT is unset the result is identical to the historical
 * `join(process.cwd(), rawPath)`.
 *
 * The caller MUST have already validated the path with isPathAllowed() —
 * this function assumes a whitelisted input and does no traversal guarding
 * of its own.
 */
export function resolveLocalDataPath(rawPath: string): string {
  const memoryRoot = process.env.MEMORY_ROOT;
  if (!memoryRoot) {
    return join(/* turbopackIgnore: true */ process.cwd(), rawPath);
  }
  const normalized = normalizePath(rawPath);
  if (normalized === "memory" || normalized.startsWith("memory/")) {
    // Runtime-configured data root — intentionally outside the traced project.
    return join(
      /* turbopackIgnore: true */ getMemoryRoot(),
      normalized.slice("memory".length)
    );
  }
  return join(/* turbopackIgnore: true */ process.cwd(), normalized);
}

/**
 * Normalize a user-provided path to prevent traversal attacks.
 * - Decodes URI-encoded characters
 * - Converts Windows backslashes to forward slashes
 * - Resolves "." and ".." segments
 * - Strips leading slashes for prefix matching
 */
export function normalizePath(rawPath: string): string {
  // Decode URI components (e.g., %2F → /)
  let normalized = rawPath;
  try {
    normalized = decodeURIComponent(rawPath);
  } catch {
    // If decoding fails, use raw path — whitelist check will reject it
  }

  // Convert Windows backslashes to forward slashes
  normalized = normalized.replace(/\\/g, "/");

  // Resolve relative segments (./ ../)
  const segments = normalized.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join("/");
}

/**
 * Check if a path is within the allowed directories.
 * Always normalize before checking — never trust raw input.
 */
export function isPathAllowed(rawPath: string): boolean {
  const normalized = normalizePath(rawPath);

  // Reject empty paths
  if (!normalized) {
    return false;
  }

  // Reject absolute paths (Unix and Windows)
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return false;
  }

  // Must match one of the allowed prefixes
  // Also check with trailing slash for bare directory names (e.g. "memory" → "memory/")
  return ALLOWED_PATHS.some(
    (prefix) => normalized.startsWith(prefix) || (normalized + "/").startsWith(prefix)
  );
}

/**
 * Get the list of allowed path prefixes.
 */
export function getAllowedPaths(): readonly string[] {
  return ALLOWED_PATHS;
}

/**
 * System-managed paths that agent WRITE tools must not touch, even though they
 * live inside the whitelist and remain readable. These files have a strict
 * schema/contract the app maintains (episodic slices + indexes) or feed the
 * system prompt through previously.md evolution, never a generic write).
 */
const PROTECTED_WRITE_PATTERNS: RegExp[] = [
  /^memory\/episodic\//, // system-owned slices + indexes
  /(^|\/)_index\.json$/, // any monthly/day index
  /(^|\/)strands\.json$/, // the strand (keyword→slice) index
];

/**
 * True if a path is inside the whitelist but is system-managed and must not be
 * written by the generic write tool. Always normalize before checking.
 */
export function isProtectedSystemPath(rawPath: string): boolean {
  const normalized = normalizePath(rawPath);
  return PROTECTED_WRITE_PATTERNS.some((pattern) => pattern.test(normalized));
}
