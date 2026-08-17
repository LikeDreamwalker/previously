/**
 * Shift all demo persona dates back by 3 years.
 * Timeline: 2025-2028 → 2022-2025 (all before 2026-07).
 * Run: node scripts/shift-demo-dates.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEMO = join(ROOT, "memory", "demo", "personal_14", "episodic", "slices");

const SHIFT_YEARS = 3;

function shiftDate(iso) {
  // Shift an ISO date string or bare date by -SHIFT_YEARS
  const match = iso.match(/^(\d{4})(-\d{2}-\d{2}.*)$/);
  if (!match) return iso;
  const newYear = parseInt(match[1], 10) - SHIFT_YEARS;
  return `${newYear}${match[2]}`;
}

function shiftTimestampInLine(line) {
  // Shift timestamps in turn headers: "## Turn N — TIMESTAMP (role)"
  return line.replace(/(\d{4})(-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g, (_, y, rest) => {
    const newYear = parseInt(y, 10) - SHIFT_YEARS;
    return `${newYear}${rest}`;
  });
}

// ─── Step 1: Collect all .md files, compute new paths ────────────────────

const moves = []; // { oldPath, newPath, oldRel, newRel }

function scanDir(dir, relPath = "") {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = relPath ? `${relPath}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // Shift year in directory name
      const yearMatch = e.name.match(/^(\d{4})$/);
      if (yearMatch) {
        const newYear = parseInt(yearMatch[1], 10) - SHIFT_YEARS;
        const newName = String(newYear);
        const newFull = join(dir, newName);
        scanDir(full, rel); // scan old dir, will move later
        // Record directory rename
        if (newName !== e.name) {
          moves.push({ oldPath: full, newPath: newFull, isDir: true });
        }
      } else {
        scanDir(full, rel);
      }
    } else if (e.name.endsWith(".md")) {
      const newRel = rel.replace(/(\d{4})/g, (y) => String(parseInt(y, 10) - SHIFT_YEARS));
      const newFull = join(DEMO, newRel);
      moves.push({ oldPath: full, newPath: newFull, isDir: false, oldRel: rel, newRel });
    }
    // _index.json stays in place after directory rename
  }
}

scanDir(DEMO);

// ─── Step 2: Move directories first (deepest first to avoid conflicts) ──
const dirMoves = moves.filter(m => m.isDir);
dirMoves.sort((a, b) => b.oldPath.length - a.oldPath.length); // deepest first

for (const m of dirMoves) {
  if (!existsSync(m.newPath)) {
    mkdirSync(m.newPath, { recursive: true });
  }
  // Move contents from old to new
  const entries = readdirSync(m.oldPath, { withFileTypes: true });
  for (const e of entries) {
    const oldEntry = join(m.oldPath, e.name);
    const newEntry = join(m.newPath, e.name);
    if (!existsSync(newEntry)) {
      if (e.isDirectory()) {
        mkdirSync(newEntry, { recursive: true });
        const subEntries = readdirSync(oldEntry);
        for (const se of subEntries) {
          const src = join(oldEntry, se);
          const dst = join(newEntry, se);
          writeFileSync(dst, readFileSync(src));
        }
      } else {
        writeFileSync(newEntry, readFileSync(oldEntry));
      }
    }
  }
  // Remove old directory
  try { rmSync(m.oldPath, { recursive: true, force: true }); } catch {}
}

// ─── Step 3: Process .md files (shift dates in content) ─────────────────

let fileCount = 0;
const fileMoves = moves.filter(m => !m.isDir);

for (const m of fileMoves) {
  let raw;
  try {
    raw = readFileSync(m.newPath, "utf-8");
  } catch {
    // Try old path
    try {
      raw = readFileSync(m.oldPath, "utf-8");
    } catch {
      console.error(`  MISSING: ${m.oldRel}`);
      continue;
    }
  }

  // Shift dates in frontmatter and body
  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) { console.error(`  NO FM: ${m.newRel}`); continue; }

  let fm = raw.slice(0, fmEnd + 3);
  let body = raw.slice(fmEnd + 3);

  // Shift frontmatter dates
  fm = fm.replace(/^slice_id:\s*(\d{4})(-\d{2}-\d{2})$/gm, (_, y, rest) =>
    `slice_id: ${parseInt(y, 10) - SHIFT_YEARS}${rest}`
  );
  fm = fm.replace(/^(start|end):\s*"(\d{4})(-\d{2}-\d{2}[^"]*)"$/gm, (_, key, y, rest) =>
    `${key}: "${parseInt(y, 10) - SHIFT_YEARS}${rest}"`
  );

  // Shift turn timestamps in body
  const bodyLines = body.split("\n");
  const shiftedBody = bodyLines.map(line => shiftTimestampInLine(line)).join("\n");

  const updated = fm + shiftedBody;
  writeFileSync(m.newPath, updated, "utf-8");
  fileCount++;
}

console.log(`Shifted ${fileCount} slice files.`);

// ─── Step 4: Update _index.json files ───────────────────────────────────

function scanIndexDirs(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...scanIndexDirs(full));
    } else if (e.name === "_index.json") {
      results.push(full);
    }
  }
  return results;
}

const indexFiles = scanIndexDirs(DEMO);
let idxCount = 0;

for (const indexPath of indexFiles) {
  const index = JSON.parse(readFileSync(indexPath, "utf-8"));
  let changed = false;

  // Update month in index
  if (index.month) {
    const m = index.month.match(/^(\d{4})(-\d{2})$/);
    if (m) {
      index.month = `${parseInt(m[1], 10) - SHIFT_YEARS}${m[2]}`;
      changed = true;
    }
  }

  // Update start dates in slices
  for (const s of (index.slices || [])) {
    if (s.start) {
      const sm = s.start.match(/^(\d{4})(-\d{2}-\d{2}.*)$/);
      if (sm) {
        s.start = `${parseInt(sm[1], 10) - SHIFT_YEARS}${sm[2]}`;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
    idxCount++;
  }
}

console.log(`Updated ${idxCount} index files.`);

// ─── Step 5: Update strands.json ──────────────────────────────────────

const tagIndexPath = join(ROOT, "memory", "demo", "personal_14", "episodic", "strands.json");
if (existsSync(tagIndexPath)) {
  const tagIndex = JSON.parse(readFileSync(tagIndexPath, "utf-8"));
  for (const [tag, paths] of Object.entries(tagIndex)) {
    tagIndex[tag] = paths.map(p => {
      return p.replace(/(\d{4})(\/\d{2}\/\d{2})/g, (_, y, rest) =>
        `${parseInt(y, 10) - SHIFT_YEARS}${rest}`
      );
    });
  }
  writeFileSync(tagIndexPath, JSON.stringify(tagIndex, null, 2) + "\n", "utf-8");
  console.log("Updated strands.json");
}

// ─── Step 6: Clean up empty old-year directories ────────────────────────

function cleanEmptyDirs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      const full = join(dir, e.name);
      const yearMatch = e.name.match(/^(\d{4})$/);
      if (yearMatch && parseInt(yearMatch[1], 10) >= 2026) {
        // Old year that should be removed if empty
        const subEntries = readdirSync(full);
        if (subEntries.length === 0) {
          rmSync(full, { recursive: true, force: true });
        }
      }
      cleanEmptyDirs(full);
    }
  }
}
cleanEmptyDirs(DEMO);

console.log("Done!");
