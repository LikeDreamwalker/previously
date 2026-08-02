#!/usr/bin/env node
/**
 * Vercel build-ignore command.
 *
 * Skips the build when ONLY files under memory/ tasks/ sessions/ changed since
 * the last successful deployment; builds otherwise.
 *
 * Uses the GitHub compare API instead of local git, so it works regardless of
 * the build machine's clone depth and spans the whole gap since the last
 * deploy. The repo is public, so no token is required; when GITHUB_TOKEN is
 * present it is used to lift the unauthenticated rate limit.
 *
 * Exit codes follow Vercel's convention: 1 = build, 0 = skip. Any uncertainty
 * (missing env vars, network error, API error, truncated file list) defaults
 * to building — a skipped deploy is worse than an extra one.
 *
 * Note: the exit status is set via `process.exitCode`, never `process.exit()`
 * while a fetch is in flight, so pending socket cleanup completes naturally.
 */

const DATA_DIRS = /^(memory|tasks|sessions)\//;

const {
  VERCEL_GIT_PREVIOUS_SHA,
  VERCEL_GIT_COMMIT_SHA,
  VERCEL_GIT_REPO_OWNER,
  VERCEL_GIT_REPO_SLUG,
  GITHUB_TOKEN,
} = process.env;

// First deployment / new branch: nothing to compare against — build.
// (These guards run before any network I/O, so a direct exit is safe.)
if (!VERCEL_GIT_PREVIOUS_SHA) {
  console.log("[vercel-ignore] no previous SHA — building (first deploy)");
  process.exit(1);
}

if (!VERCEL_GIT_COMMIT_SHA || !VERCEL_GIT_REPO_OWNER || !VERCEL_GIT_REPO_SLUG) {
  console.error("[vercel-ignore] missing repo env vars — building to be safe");
  process.exit(1);
}

/** Resolve to 1 (build) or 0 (skip). */
async function decide() {
  const url =
    `https://api.github.com/repos/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}` +
    `/compare/${VERCEL_GIT_PREVIOUS_SHA}...${VERCEL_GIT_COMMIT_SHA}`;
  const headers = { "User-Agent": "vercel-ignore" };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`[vercel-ignore] compare API ${res.status} — building to be safe`);
    return 1;
  }

  const data = await res.json();
  const files = Array.isArray(data.files) ? data.files : [];

  // GitHub caps the compare file list at 300. A truncated list means we
  // cannot be sure nothing outside the data dirs changed — build.
  if (files.length >= 300) {
    console.warn(`[vercel-ignore] compare file list truncated (${files.length}) — building to be safe`);
    return 1;
  }

  const codeChanged = files.some(
    (f) => f && typeof f.filename === "string" && !DATA_DIRS.test(f.filename),
  );

  if (codeChanged) {
    console.log("[vercel-ignore] code files changed — building");
    return 1;
  }

  console.log(`[vercel-ignore] only data files changed (${files.length}) — skipping build`);
  return 0;
}

decide()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[vercel-ignore] error: ${err?.message ?? err} — building to be safe`);
    process.exitCode = 1;
  });
