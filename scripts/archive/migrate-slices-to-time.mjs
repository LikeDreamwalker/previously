/**
 * Migrate demo episodic slices from day-granular to time-granular storage.
 *
 *   before:  slices/YYYY/MM/DD.md          slice_id: YYYY-MM-DD
 *   after:   slices/YYYY/MM/DD/HHMM.md     slice_id: YYYY-MM-DD-HHMM
 *
 * HHMM is derived from the UTC hour+minute of each slice's `start` timestamp.
 * Mechanical only — one slice per day stays one slice (no splitting).
 *
 * Idempotent: HHMM is sourced from `_index.json` `start` values (authoritative,
 * independent of file moves), and already-migrated ids/paths (4 segments) are
 * skipped. Safe to re-run.
 *
 * Run: node scripts/migrate-slices-to-time.mjs
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EPISODIC = join(ROOT, "memory", "demo", "personal_14", "episodic");
const SLICES = join(EPISODIC, "slices");

/** UTC HHMM (e.g. "1558") from an ISO timestamp. */
function hhmmFromStart(start) {
  const d = new Date(start);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

function findIndexFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findIndexFiles(full));
    else if (e.name === "_index.json") out.push(full);
  }
  return out;
}

function findMarkdownFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// ─── Step 1: Build authoritative YYYY/MM/DD → HHMM map from _index.json ───

const indexFiles = findIndexFiles(SLICES);
const dayToHHMM = new Map(); // "YYYY/MM/DD" → "HHMM"
const monthToSlices = new Map(); // "YYYY/MM" → [{ day, hhmm }]

for (const idxPath of indexFiles) {
  const index = JSON.parse(readFileSync(idxPath, "utf-8"));
  for (const s of index.slices || []) {
    const parts = String(s.id).split("-"); // YYYY-MM-DD or YYYY-MM-DD-HHMM
    const key = `${parts[0]}/${parts[1]}/${parts[2]}`;
    const hhmm = parts.length >= 4 ? parts[3] : hhmmFromStart(s.start);
    dayToHHMM.set(key, hhmm);
    const mk = `${parts[0]}/${parts[1]}`;
    if (!monthToSlices.has(mk)) monthToSlices.set(mk, []);
    monthToSlices.get(mk).push({ day: parts[2], hhmm });
  }
}

// ─── Step 2: Move DD.md → DD/HHMM.md and rewrite slice_id ────────────────

let moved = 0;
for (const filePath of findMarkdownFiles(SLICES)) {
  const stem = basename(filePath, ".md");
  if (!/^\d{2}$/.test(stem)) continue; // already migrated (HHMM.md) — skip

  const rel = filePath.slice(SLICES.length + 1).replace(/\\/g, "/"); // YYYY/MM/DD.md
  const [year, month] = rel.split("/");
  const key = `${year}/${month}/${stem}`;

  const raw = readFileSync(filePath, "utf-8");
  const startMatch = raw.match(/^start:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const hhmm = dayToHHMM.get(key) ?? (startMatch ? hhmmFromStart(startMatch[1]) : null);
  if (!hhmm) {
    console.error(`  SKIP (no start/HHMM): ${rel}`);
    continue;
  }

  // Rewrite the slice_id line, preserving any quote style, appending -HHMM.
  const updated = raw.replace(
    /^(slice_id:\s*['"]?)(\d{4}-\d{2}-\d{2})(['"]?\s*)$/m,
    (_, pre, id, post) => `${pre}${id}-${hhmm}${post}`
  );

  const newFull = join(dirname(filePath), stem, `${hhmm}.md`);
  mkdirSync(dirname(newFull), { recursive: true });
  writeFileSync(newFull, updated, "utf-8");
  rmSync(filePath, { force: true });
  moved++;
}
console.log(`Moved ${moved} slice files → DD/HHMM.md`);

// ─── Step 3: Update _index.json ids to YYYY-MM-DD-HHMM ───────────────────

let idxUpdated = 0;
for (const idxPath of indexFiles) {
  const index = JSON.parse(readFileSync(idxPath, "utf-8"));
  let changed = false;
  for (const s of index.slices || []) {
    if (/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(s.id)) continue; // already migrated
    if (/^\d{4}-\d{2}-\d{2}$/.test(s.id)) {
      s.id = `${s.id}-${hhmmFromStart(s.start)}`;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(idxPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
    idxUpdated++;
  }
}
console.log(`Updated ${idxUpdated} _index.json files`);

// ─── Step 4: Update strands.json paths YYYY/MM/DD → YYYY/MM/DD/HHMM ─────

const tagIndexPath = join(EPISODIC, "strands.json");
if (existsSync(tagIndexPath)) {
  const tagIndex = JSON.parse(readFileSync(tagIndexPath, "utf-8"));
  let remapped = 0;
  let repaired = 0;
  let missing = 0;
  for (const [tag, paths] of Object.entries(tagIndex)) {
    tagIndex[tag] = paths.map((p) => {
      if (/^\d{4}\/\d{2}\/\d{2}\/\d{4}$/.test(p)) return p; // already migrated
      const m = p.match(/^(\d{4}\/\d{2})\/(\d{2})$/);
      if (!m) return p;
      const monthKey = m[1];
      const hhmm = dayToHHMM.get(`${monthKey}/${m[2]}`);
      if (hhmm) {
        remapped++;
        return `${p}/${hhmm}`;
      }
      // Fallback: dangling day (pre-existing off-by-one). If the month has
      // exactly one slice, this tag unambiguously belongs to it — repair it.
      const monthSlices = monthToSlices.get(monthKey);
      if (monthSlices && monthSlices.length === 1) {
        const s = monthSlices[0];
        repaired++;
        return `${monthKey}/${s.day}/${s.hhmm}`;
      }
      missing++;
      console.error(`  strands: no HHMM for ${p} (tag "${tag}")`);
      return p;
    });
  }
  writeFileSync(tagIndexPath, JSON.stringify(tagIndex, null, 2) + "\n", "utf-8");
  console.log(
    `Updated strands.json (${remapped} remapped, ${repaired} dangling repaired, ${missing} unresolved)`
  );
}

console.log("Done!");
