#!/usr/bin/env node
/**
 * pack-standalone.mjs — dereference every symlink inside .next/standalone.
 *
 * Next.js `output: "standalone"` mirrors the pnpm node_modules layout with
 * symlinks. On Windows these come out as (a) broken file-type links to pnpm
 * directory targets (statSync → EPERM) and (b) absolute links pointing back
 * into the build repo — the artifact is not relocatable as-built. Shipped
 * artifacts must be a pure file tree with zero symlinks, so this script
 * replaces every link (file or dir, relative or absolute target, symlink or
 * junction) with the real content of its resolved target.
 *
 * Naively copying a directory target is NOT enough: Node resolves a package's
 * dependencies by walking up from the module's real path, which for a pnpm
 * symlink is the `.pnpm/<pkg>@<ver>/node_modules` context directory. To
 * preserve that semantics in a link-free tree, each dereferenced directory
 * additionally embeds a copy of its original node_modules context into
 * `<dest>/node_modules` (recursively), so every package stays self-contained.
 *
 * CI MUST run this before packaging the `@previously-lab/kernel` artifact
 * (`pnpm build:standalone` runs `pnpm build` then this script).
 *
 * Detection uses lstat + readlink (never statSync) so broken Windows links
 * are handled. Idempotent: a second run is a no-op. Exits non-zero if any
 * link target is genuinely missing or a true symlink cycle is detected.
 *
 * After dereferencing, the script copies `.next/static` and `public/` into
 * the standalone tree (`.next/standalone/.next/static` and
 * `.next/standalone/public`). Next's minimal `server.js` does NOT include
 * these by default — the official docs require copying them manually, and
 * without them every `/_next/static/*` asset (css/js chunks, fonts) 404s
 * when the standalone server serves browser pages. A missing `public/` is
 * tolerated.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = join(repoRoot, ".next", "standalone");

if (!existsSync(standaloneDir) || !lstatSync(standaloneDir).isDirectory()) {
  console.error(`pack-standalone: ${standaloneDir} does not exist — run \`pnpm build\` first.`);
  process.exit(1);
}

/** Follow a symlink chain to the final non-link path. Throws on missing target or cycle. */
function resolveLinkChain(linkPath) {
  const seen = new Set();
  let current = linkPath;
  while (lstatSync(current).isSymbolicLink()) {
    if (seen.has(current)) {
      throw new Error(`symlink cycle while resolving ${linkPath}`);
    }
    seen.add(current);
    // readlink works on broken links where statSync would fail; targets may
    // be relative to the link's directory or absolute (both handled by resolve).
    current = resolve(dirname(current), readlinkSync(current));
  }
  return current;
}

/** Nearest ancestor directory named "node_modules" (the pnpm resolution context), or null. */
function contextDir(p) {
  let d = dirname(p);
  while (basename(d) !== "node_modules") {
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return d;
}

// Reference-counted set of real paths currently being copied (recursion
// path). Guards against symlink cycles while allowing one level of re-entry
// for pnpm peer-dependency cycles during context embedding.
class PathStack {
  #counts = new Map();
  has(real) {
    return this.#counts.has(real);
  }
  add(real) {
    this.#counts.set(real, (this.#counts.get(real) ?? 0) + 1);
  }
  remove(real) {
    const n = this.#counts.get(real) - 1;
    if (n <= 0) this.#counts.delete(real);
    else this.#counts.set(real, n);
  }
}

/**
 * Copy the real content of srcReal (link-free at the top level) to dest,
 * recursively dereferencing nested symlinks and embedding each directory's
 * node_modules context so module resolution works without symlinks.
 * `fromLink` marks entries reached by following a symlink; a symlink whose
 * target is already on the copy stack is a true cycle (peer-dep re-entry is
 * only permitted via context embedding).
 */
function copyReal(srcReal, dest, stack, fromLink) {
  const st = lstatSync(srcReal);
  if (st.isSymbolicLink()) {
    copyReal(resolveLinkChain(srcReal), dest, stack, true);
    return;
  }
  if (st.isDirectory()) {
    const real = realpathSync(srcReal);
    if (fromLink && stack.has(real)) {
      throw new Error(`symlink cycle detected: ${srcReal} resolves to a directory already being copied`);
    }
    const reentry = stack.has(real);
    stack.add(real);
    try {
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(srcReal)) {
        copyReal(join(srcReal, entry), join(dest, entry), stack, false);
      }
      // Emulate symlink semantics: resolution from a symlinked package happens
      // at its real location, whose parent node_modules holds the package's
      // dependencies. Embed that context so the dereferenced copy stays
      // resolvable. Only directories that were themselves reached through a
      // symlink are package roots in a node_modules context — plain content
      // subdirectories must not get an embed. Skipped on re-entry (dependency
      // cycle) — the ancestor copy higher up already carries it.
      if (fromLink && !reentry) {
        const ctx = contextDir(srcReal);
        if (ctx !== null) {
          embedContext(ctx, relative(ctx, srcReal).split(sep), join(dest, "node_modules"), stack);
        }
      }
    } finally {
      stack.remove(real);
    }
    return;
  }
  copyFileSync(srcReal, dest);
  chmodSync(dest, st.mode); // preserve executable bits for Linux/macOS targets
}

/**
 * Copy every entry of a context dir into destNm, excluding the sub-path that
 * leads back to the package being copied (excludeRel). Existing entries win
 * (a package's own vendored node_modules takes precedence, matching Node's
 * resolution order).
 */
function embedContext(ctx, excludeRel, destNm, stack) {
  for (const entry of readdirSync(ctx)) {
    if (entry === excludeRel[0]) {
      if (excludeRel.length > 1) {
        embedContext(join(ctx, entry), excludeRel.slice(1), join(destNm, entry), stack);
      }
      continue;
    }
    const dest = join(destNm, entry);
    if (existsSync(dest)) continue;
    copyReal(join(ctx, entry), dest, stack, false);
  }
}

/** Collect every symlink in the tree, deepest first. */
function collectLinks(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      out.push(p);
    } else if (st.isDirectory()) {
      collectLinks(p, out);
    }
  }
  return out;
}

const links = collectLinks(standaloneDir, []);
let ok = 0;
const failures = [];

for (const link of links.sort().reverse()) {
  try {
    const target = resolveLinkChain(link);
    const st = lstatSync(target); // throws ENOENT if the target is genuinely missing
    rmSync(link, { force: true, recursive: false });
    copyReal(target, link, new PathStack(), true);
    ok += 1;
    console.log(`dereferenced: ${link.slice(standaloneDir.length + 1)} -> ${st.isDirectory() ? "dir" : "file"}`);
  } catch (err) {
    failures.push(`${link.slice(standaloneDir.length + 1)}: ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\npack-standalone: ${failures.length} link(s) could not be dereferenced:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`\npack-standalone: ${ok} symlink(s) dereferenced in ${standaloneDir}`);

// Next's standalone server does not include `.next/static` or `public/` —
// the docs require copying them in manually so server.js can serve them.
// Copy AFTER dereferencing so the destinations stay a pure file tree.
// Idempotent: cpSync overwrites existing files; a missing `public/` is fine.
for (const [src, dest] of [
  [join(repoRoot, ".next", "static"), join(standaloneDir, ".next", "static")],
  [join(repoRoot, "public"), join(standaloneDir, "public")],
]) {
  if (!existsSync(src)) {
    console.log(`pack-standalone: ${src.slice(repoRoot.length + 1)} not found — skipped`);
    continue;
  }
  cpSync(src, dest, { recursive: true, force: true, dereference: true });
  console.log(`pack-standalone: copied ${src.slice(repoRoot.length + 1)} -> ${dest.slice(repoRoot.length + 1)}`);
}

// ── Size summary ─────────────────────────────────────────────────────────
// Print top-level entry sizes plus the total so artifact bloat regressions
// (e.g. data directories accidentally traced into standalone) are visible in
// every build log.
function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length > 0) {
    const cur = stack.pop();
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) continue; // none should remain; never follow
    if (st.isDirectory()) {
      for (const entry of readdirSync(cur)) stack.push(join(cur, entry));
    } else {
      total += st.size;
    }
  }
  return total;
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

let totalSize = 0;
const rows = [];
for (const entry of readdirSync(standaloneDir)) {
  const size = dirSize(join(standaloneDir, entry));
  totalSize += size;
  rows.push(`  ${formatSize(size).padStart(8)}  ${entry}`);
}
rows.sort();
console.log(`\npack-standalone: size summary for ${standaloneDir.slice(repoRoot.length + 1)}`);
for (const row of rows) console.log(row);
console.log(`  ${formatSize(totalSize).padStart(8)}  TOTAL`);
