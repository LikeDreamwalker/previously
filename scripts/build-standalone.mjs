#!/usr/bin/env node
/**
 * build-standalone.mjs — kernel packaging build (build + pack).
 *
 * Sets NEXT_PUBLIC_PREVIOUSLY_TARGET=client for the Next build so the
 * bundler keeps client-only UI (see src/components/layout/client-badge.tsx)
 * in the kernel artifact. Cloud deployments set it to "cloud" instead to
 * tree-shake that UI out of the browser bundle; unset keeps runtime-gated
 * behavior for local dev. Inline `VAR=value` in package.json scripts is not
 * cross-platform (Windows cmd), so the env var is set here before spawning.
 *
 * Runs `pnpm build` (so the prebuild identity generation still runs) and
 * then scripts/pack-standalone.mjs — same steps as before, pack behavior
 * unchanged.
 */

import { spawn } from "node:child_process";

process.env.NEXT_PUBLIC_PREVIOUSLY_TARGET = "client";

/** Spawn a command with inherited stdio; reject on non-zero exit. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    // shell: true resolves pnpm.cmd on Windows.
    const child = spawn(cmd, args, { stdio: "inherit", shell: true });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

try {
  await run("pnpm", ["build"]);
  await run("node", ["scripts/pack-standalone.mjs"]);
} catch (err) {
  console.error(`build-standalone: ${err.message}`);
  process.exit(1);
}
