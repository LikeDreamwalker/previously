#!/usr/bin/env node
/**
 * pack-kernel.mjs — assemble the publishable `previously-kernel` npm package.
 *
 * Copies `.next/standalone` (already dereferenced by pack-standalone.mjs, so
 * a pure file tree) into `dist-kernel/standalone` and writes the package
 * manifest + README around it. The client installs this package as a
 * dependency and boots `standalone/server.js` — end-user machines never run
 * a Next build.
 *
 * The version is read from APP_VERSION in src/lib/version/constants.ts (the
 * single source of truth, bumped by .github/workflows/bump-version.yml).
 * release-kernel.yml overrides it with PREVIOUSLY_KERNEL_VERSION (derived
 * from the pushed tag) because bump-version runs AFTER the GitHub Release is
 * published — the tag is the authority at packaging time.
 *
 * Idempotent: dist-kernel/ is removed and rebuilt on every run.
 * Requires `pnpm build:standalone` to have run first.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = join(repoRoot, ".next", "standalone");
const distDir = join(repoRoot, "dist-kernel");

if (!existsSync(standaloneDir)) {
  console.error("pack-kernel: .next/standalone does not exist — run `pnpm build:standalone` first.");
  process.exit(1);
}

// Version: the release tag wins (PREVIOUSLY_KERNEL_VERSION, set by
// release-kernel.yml — bump-version only syncs APP_VERSION after the release,
// so the tag is the authority at packaging time); APP_VERSION is the local
// fallback (same constant the running kernel reports via GET /api/version).
const constantsSrc = readFileSync(join(repoRoot, "src", "lib", "version", "constants.ts"), "utf8");
const versionMatch = constantsSrc.match(/APP_VERSION\s*=\s*"([^"]+)"/);
if (!versionMatch) {
  console.error("pack-kernel: could not find APP_VERSION in src/lib/version/constants.ts");
  process.exit(1);
}
const version = (process.env.PREVIOUSLY_KERNEL_VERSION ?? versionMatch[1]).trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`pack-kernel: invalid version "${version}" (APP_VERSION or PREVIOUSLY_KERNEL_VERSION)`);
  process.exit(1);
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

cpSync(standaloneDir, join(distDir, "standalone"), { recursive: true, dereference: true });

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: "previously-kernel",
      version,
      description:
        "Standalone kernel build of previously (Next.js output:standalone). " +
        "Consumed as a dependency by previously-client; not intended for direct use.",
      private: false,
      files: ["standalone", "README.md"],
    },
    null,
    2
  ) + "\n"
);

writeFileSync(
  join(distDir, "README.md"),
  `# previously-kernel

Packaged standalone kernel of [previously](https://github.com/previously-lab/agent)
(Next.js \`output: "standalone"\` build, symlinks dereferenced).

This package is a build artifact consumed as a dependency by the
\`previously\` client CLI, which boots \`standalone/server.js\` with the
appropriate environment (\`PREVIOUSLY_HOME\`, \`PREVIOUSLY_MODE=client\`,
\`MEMORY_ROOT\`, ...). It is not intended to be installed or run directly.
`
);

console.log(`pack-kernel: assembled previously-kernel@${version} in ${distDir.slice(repoRoot.length + 1)}/`);
