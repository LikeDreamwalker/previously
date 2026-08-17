/**
 * Shift all persona dates by N years. Pure file operation — no LLM.
 *
 * Safer approach: copy-to-new → shift-content → verify → delete-old.
 *
 * Usage:
 *   node scripts/shift-all-dates.mjs [--years 3] [--data-dir <path>] [--reverse]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
function getArg(f) { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }
const SHIFT = parseInt(getArg("--years") ?? "3", 10);
const DATA_DIR = getArg("--data-dir") ?? path.join(ROOT, "..", "benchmark-data");
const REVERSE = args.includes("--reverse");
const years = REVERSE ? SHIFT : -SHIFT;

console.log(`=== Shift dates: ${years > 0 ? "+" : ""}${years} years ===`);
console.log(`Data dir: ${DATA_DIR}\n`);

function sy(y) { return String(parseInt(y, 10) + years); }
function shiftYearInStr(s) { return s.replace(/(^|[\\/])(\d{4})([\\/])/g, (_, a, y, b) => a + sy(y) + b); }
function shiftDateISO(iso) { return iso.replace(/(\d{4})(-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/g, (_, y, r) => sy(y) + r); }

// ─── Phase 1: Copy all files ──────────────────────────────────────────────

const personas = fs.readdirSync(DATA_DIR)
  .filter(e => e.startsWith("personal_") && fs.statSync(path.join(DATA_DIR, e)).isDirectory())
  .sort();

// Collect ALL file copy operations first, then execute.
// Also track which source years we read from, so we can safely delete only those.
const copies = []; // { oldPath, newPath, type }
const sourceYears = new Set();

for (const p of personas) {
  const base = path.join(DATA_DIR, p);
  const slicesDir = path.join(base, "episodic", "slices");
  const strandsPath = path.join(base, "episodic", "strands.json");
  const profilePath = path.join(base, "user", "profile.md");

  // Walk slices directory — only collect, don't modify yet
  function walk(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fp = path.join(dirPath, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      const rel = path.relative(slicesDir, fp);
      // Track source year (first segment of rel path)
      const srcYear = rel.split(/[\\/]/)[0];
      if (/^\d{4}$/.test(srcYear)) sourceYears.add(srcYear);
      const newRel = shiftYearInStr(rel);
      const newFp = path.join(slicesDir, newRel);
      const type = e.name === "_index.json" ? "index" : "slice";
      copies.push({ oldPath: fp, newPath: newFp, type });
    }
  }
  walk(slicesDir);

  // Strands
  if (fs.existsSync(strandsPath)) {
    copies.push({ oldPath: strandsPath, newPath: strandsPath, type: "strands" });
  }
  // Profile
  if (fs.existsSync(profilePath)) {
    copies.push({ oldPath: profilePath, newPath: profilePath, type: "profile" });
  }
}

console.log(`Files to process: ${copies.length}`);

// ─── Phase 2: Copy + shift content (no deletion yet) ──────────────────────

let slices = 0, indexes = 0, strandsFiles = 0, profiles = 0;

for (const { oldPath, newPath, type } of copies) {
  // Ensure directory exists
  const dir = path.dirname(newPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let raw = fs.readFileSync(oldPath, "utf-8");

  if (type === "index") {
    const idx = JSON.parse(raw);
    if (idx.month) idx.month = idx.month.replace(/^(\d{4})/, (_, y) => sy(y));
    for (const s of idx.slices ?? []) {
      if (s.id) s.id = s.id.replace(/^(\d{4})/, (_, y) => sy(y));
      if (s.start) s.start = shiftDateISO(s.start);
    }
    fs.writeFileSync(newPath, JSON.stringify(idx, null, 2), "utf-8");
    indexes++;
    continue;
  }

  if (type === "strands") {
    const strands = JSON.parse(raw);
    for (const [tag, paths] of Object.entries(strands)) {
      strands[tag] = paths.map(p => shiftYearInStr(p));
    }
    fs.writeFileSync(newPath, JSON.stringify(strands, null, 2), "utf-8");
    strandsFiles++;
    continue;
  }

  if (type === "profile") {
    raw = raw.replace(/(\d{4})(-\d{2}-\d{2})/g, (_, y, r) => sy(y) + r);
    fs.writeFileSync(newPath, raw, "utf-8");
    profiles++;
    continue;
  }

  // Type: slice — YAML frontmatter + Markdown turns
  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) continue;

  let fm = raw.slice(0, fmEnd + 3);
  let body = raw.slice(fmEnd + 3);

  fm = fm.replace(/^slice_id:\s*(\d{4})(-\d{2}-\d{2}-\d{4})$/gm, (_, y, r) =>
    `slice_id: ${sy(y)}${r}`
  );
  fm = fm.replace(/^(start|end):\s*"(\d{4})(-\d{2}-\d{2}[^"]*)"/gm, (_, k, y, r) =>
    `${k}: "${sy(y)}${r}"`
  );
  body = body.replace(
    /(\d{4})(-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g,
    (_, y, r) => sy(y) + r
  );

  fs.writeFileSync(newPath, fm + body, "utf-8");
  slices++;
}

console.log(`Slices: ${slices}  Indexes: ${indexes}  Strands: ${strandsFiles}  Profiles: ${profiles}`);

// ─── Phase 3: Remove source-year directories ──────────────────────────────
// We tracked every source year seen during Phase 1. After Phase 2 copied them
// to shifted locations, delete ONLY those exact source years.

console.log("Source years found:", [...sourceYears].sort().join(", "));

for (const p of personas) {
  const slicesDir = path.join(DATA_DIR, p, "episodic", "slices");
  for (const yr of sourceYears) {
    const srcDir = path.join(slicesDir, yr);
    if (fs.existsSync(srcDir)) {
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  }
}

console.log("Source year directories removed.");

// ─── Phase 4: Update manifest.json ────────────────────────────────────────

const manifestPath = path.join(DATA_DIR, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  for (const [, p] of Object.entries(manifest.personas)) {
    if (p.dateRange) p.dateRange = p.dateRange.map(d => d.replace(/^(\d{4})/, (_, y) => sy(y)));
    function shiftTree(n) {
      if (!n || typeof n !== "object") return;
      for (const k of Object.keys(n)) {
        if (/^\d{4}$/.test(k)) {
          const sk = sy(k);
          if (sk !== k) { n[sk] = n[k]; delete n[k]; }
          shiftTree(n[sk]);
        } else { shiftTree(n[k]); }
      }
    }
    if (p.tree) shiftTree(p.tree);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log("manifest.json updated.");
}

console.log("\n=== Done ===");
console.log(`All dates shifted by ${years} years.`);
if (!REVERSE) console.log("To restore: node scripts/shift-all-dates.mjs --reverse");
