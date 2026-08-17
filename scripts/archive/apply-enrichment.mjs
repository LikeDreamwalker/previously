/**
 * Apply Haiku-generated tag enrichment + quality fixes to a persona.
 *
 * Reads a JSON enrichment file produced by the Haiku review agent, then:
 *   1. Updates tags / focus / summary in each slice's YAML frontmatter
 *   2. Regenerates _index.json entries
 *   3. Regenerates strands.json
 *   4. Writes a quality report to the persona root
 *
 * Usage:
 *   node scripts/apply-enrichment.mjs <persona-id> <enrichment.json>
 *
 *   persona-id      e.g. "personal_14"
 *   enrichment.json  Haiku agent output (see schema below)
 *
 * Enrichment JSON schema:
 * {
 *   "personaId": "personal_14",
 *   "reviewedAt": "2026-07-20T...",
 *   "model": "claude-haiku-4-5",
 *   "overallNotes": "any global observations about this persona",
 *   "slices": {
 *     "2025-01-08-1130": {
 *       "tags": ["flood-mitigation", "personal-intake", "career-history"],
 *       "focus": "Caleb's comprehensive personal intake",    // optional fix
 *       "summary": "Caleb completed a full personal intake…", // optional fix
 *       "emotional_tone": "positive",
 *       "open_loops": ["Follow up on mother's health", ...],  // optional
 *       "decisions": ["Save complete profile", ...],          // optional
 *       "quality": {
 *         "focus_accurate": true,
 *         "summary_accurate": true,
 *         "tags_relevant": true,
 *         "notes": "any observations about this slice"
 *       }
 *     }
 *   }
 * }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BENCHMARK_DIR = path.join(ROOT, "..", "benchmark-data");

// ─── Helpers ─────────────────────────────────────────────────────────────

function personaDir(personaId) {
  return path.join(BENCHMARK_DIR, personaId);
}

function slicesDir(personaId) {
  return path.join(personaDir(personaId), "episodic", "slices");
}

function slicePath(personaId, sliceId) {
  // sliceId = YYYY-MM-DD-HHMM → YYYY/MM/DD/HHMM.md
  const [y, m, d, hhmm] = sliceId.split("-");
  return path.join(slicesDir(personaId), y, m, d, `${hhmm}.md`);
}

/** Parse a slice .md file → { frontmatter (raw string), body (raw string) } */
function readSliceRaw(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) throw new Error(`No frontmatter in ${filePath}`);
  return {
    frontmatter: raw.slice(0, fmEnd + 3),
    body: raw.slice(fmEnd + 3),
  };
}

/** Replace or add a YAML list field in the frontmatter string. */
function setYamlList(fm, key, values) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\n${escapedKey}:[\n\r](?:  - [^\n]*[\n\r]?)*`);
  const block = values.length > 0
    ? `\n${key}:\n${values.map((v) => `  - ${v}`).join("\n")}`
    : `\n${key}: []`;
  if (re.test(fm)) {
    return fm.replace(re, block);
  }
  // Key doesn't exist — insert before closing ---
  return fm.replace(/\n---$/, `${block}\n---`);
}

/** Replace or add a single YAML string field in the frontmatter. */
function setYamlString(fm, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\n${escapedKey}:.*`);
  const line = `\n${key}: ${JSON.stringify(value)}`;
  if (re.test(fm)) {
    return fm.replace(re, line);
  }
  return fm.replace(/\n---$/, `${line}\n---`);
}

function writeSliceFile(personaId, sliceId, fm, body) {
  const fp = slicePath(personaId, sliceId);
  fs.writeFileSync(fp, fm + body, "utf-8");
}

// ─── Index + strands regeneration ────────────────────────────────────────

function rebuildIndexes(personaId) {
  const dir = slicesDir(personaId);
  const byMonth = {};

  // Walk: YYYY → MM → DD → HHMM.md
  const yearDirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name));
  for (const yDir of yearDirs) {
    const yPath = path.join(dir, yDir.name);
    const monthDirs = fs.readdirSync(yPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
    for (const mDir of monthDirs) {
      const mPath = path.join(yPath, mDir.name);
      const dayDirs = fs.readdirSync(mPath, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
      for (const dDir of dayDirs) {
        const dPath = path.join(mPath, dDir.name);
        const mdFiles = fs.readdirSync(dPath).filter((f) => f.endsWith(".md"));
        for (const mf of mdFiles) {
          const raw = readSliceRaw(path.join(dPath, mf));
          const sidMatch = raw.frontmatter.match(/slice_id:\s*(\S+)/);
          if (!sidMatch) continue;
          const sliceId = sidMatch[1];
          const [y, mo] = sliceId.split("-");
          const key = `${y}-${mo}`;
          if (!byMonth[key]) byMonth[key] = [];

          const focus = (raw.frontmatter.match(/focus:\s*(.+)/) ?? [])[1] ?? "";
          const summary = (raw.frontmatter.match(/summary:\s*(.+)/) ?? [])[1] ?? "";
          const status = (raw.frontmatter.match(/status:\s*(\S+)/) ?? [])[1] ?? "closed";
          const start = (raw.frontmatter.match(/start:\s*"([^"]+)"/) ?? [])[1] ?? "";
          const tagsMatch = raw.frontmatter.match(/tags:\n((?:  - [^\n]+\n?)*)/);
          const tags = tagsMatch
            ? tagsMatch[1].split("\n").filter(Boolean).map((l) => l.replace(/^\s*-\s*/, "").replace(/^"(.*)"$/, "$1"))
            : [];

          const openLoops = [];
          const decisions = [];
          let inLoops = false, inDecisions = false;
          for (const line of raw.frontmatter.split("\n")) {
            if (line.startsWith("open_loops:")) { inLoops = true; inDecisions = false; continue; }
            if (line.startsWith("decisions:")) { inDecisions = true; inLoops = false; continue; }
            if (inLoops && line.match(/^\s*-\s*(.+)/)) {
              openLoops.push(line.match(/^\s*-\s*"?(.+?)"?\s*$/)?.[1] ?? "");
            } else if (inLoops && !line.startsWith("  ")) { inLoops = false; }
            if (inDecisions && line.match(/^\s*-\s*(.+)/)) {
              decisions.push(line.match(/^\s*-\s*"?(.+?)"?\s*$/)?.[1] ?? "");
            } else if (inDecisions && !line.startsWith("  ")) { inDecisions = false; }
          }

          byMonth[key].push({
            id: sliceId, focus: focus.replace(/^"/, "").replace(/"$/, ""),
            summary: summary.replace(/^"/, "").replace(/"$/, ""),
            tags, status, start: start.replace(/^"/, "").replace(/"$/, ""),
            open_loops: openLoops, decisions,
          });
        }
      }
    }
  }

  for (const [monthKey, entries] of Object.entries(byMonth)) {
    const [year, month] = monthKey.split("-");
    entries.sort((a, b) => a.id.localeCompare(b.id));
    const indexPath = path.join(dir, year, month, "_index.json");
    fs.writeFileSync(
      indexPath,
      JSON.stringify({ month: monthKey, slices: entries }, null, 2),
      "utf-8"
    );
  }

  return Object.keys(byMonth).length;
}

function rebuildStrands(personaId) {
  const dir = slicesDir(personaId);
  const strands = {};

  // Walk: YYYY → MM → DD → HHMM.md
  const years = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name));
  for (const yDir of years) {
    const months = fs.readdirSync(path.join(dir, yDir.name), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
    for (const mDir of months) {
      const mPath = path.join(dir, yDir.name, mDir.name);
      const days = fs.readdirSync(mPath, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name));
      for (const dDir of days) {
        const dPath = path.join(mPath, dDir.name);
        const mdFiles = fs.readdirSync(dPath).filter((f) => f.endsWith(".md"));
        for (const mf of mdFiles) {
          const raw = readSliceRaw(path.join(dPath, mf));
          const sidMatch = raw.frontmatter.match(/slice_id:\s*(\S+)/);
          if (!sidMatch) continue;
          const sliceId = sidMatch[1];
          const [y, m, d, hhmm] = sliceId.split("-");
          const relPath = `${y}/${m}/${d}/${hhmm}`;
          const tagsMatch = raw.frontmatter.match(/tags:\n((?:  - [^\n]+\n?)*)/);
          const tags = tagsMatch
            ? tagsMatch[1].split("\n").filter(Boolean).map((l) => l.replace(/^\s*-\s*/, ""))
            : [];
          for (const tag of tags) {
            if (!strands[tag]) strands[tag] = [];
            if (!strands[tag].includes(relPath)) strands[tag].push(relPath);
          }
        }
      }
    }
  }

  const strandsPath = path.join(personaDir(personaId), "episodic", "strands.json");
  fs.writeFileSync(strandsPath, JSON.stringify(strands, null, 2), "utf-8");
  return Object.keys(strands).length;
}

// ─── Main ─────────────────────────────────────────────────────────────────

const personaId = process.argv[2];
const enrichmentPath = process.argv[3];

if (!personaId || !enrichmentPath) {
  console.error("Usage: node scripts/apply-enrichment.mjs <persona-id> <enrichment.json>");
  process.exit(1);
}

if (!fs.existsSync(enrichmentPath)) {
  console.error(`Enrichment file not found: ${enrichmentPath}`);
  process.exit(1);
}

const enrichment = JSON.parse(fs.readFileSync(enrichmentPath, "utf-8"));

if (enrichment.personaId !== personaId) {
  console.warn(`WARNING: enrichment.personaId (${enrichment.personaId}) ≠ ${personaId}`);
}

console.log(`=== Apply Enrichment: ${personaId} ===`);
console.log(`Model: ${enrichment.model}`);
console.log(`Slices to update: ${Object.keys(enrichment.slices).length}`);

let updatedTags = 0;
let updatedFocus = 0;
let updatedSummary = 0;
let updatedOpenLoops = 0;
let updatedDecisions = 0;
const qualityIssues = [];

for (const [sliceId, update] of Object.entries(enrichment.slices)) {
  const fp = slicePath(personaId, sliceId);
  if (!fs.existsSync(fp)) {
    console.warn(`  SKIP ${sliceId}: file not found at ${fp}`);
    continue;
  }

  const { frontmatter, body } = readSliceRaw(fp);

  let fm = frontmatter;

  if (update.tags && Array.isArray(update.tags) && update.tags.length > 0) {
    fm = setYamlList(fm, "tags", update.tags);
    updatedTags++;
  }

  if (update.focus && typeof update.focus === "string") {
    fm = setYamlString(fm, "focus", update.focus);
    updatedFocus++;
  }

  if (update.summary && typeof update.summary === "string") {
    fm = setYamlString(fm, "summary", update.summary);
    updatedSummary++;
  }

  if (update.open_loops && Array.isArray(update.open_loops)) {
    fm = setYamlList(fm, "open_loops", update.open_loops);
    updatedOpenLoops++;
  }

  if (update.decisions && Array.isArray(update.decisions)) {
    fm = setYamlList(fm, "decisions", update.decisions);
    updatedDecisions++;
  }

  if (update.emotional_tone && typeof update.emotional_tone === "string") {
    fm = setYamlString(fm, "emotional_tone", update.emotional_tone);
  }

  writeSliceFile(personaId, sliceId, fm, body);

  if (update.quality) {
    const q = update.quality;
    if (!q.focus_accurate || !q.summary_accurate || !q.tags_relevant || q.notes) {
      qualityIssues.push({ sliceId, ...q });
    }
  }
}

// Rebuild indexes + strands
const indexCount = rebuildIndexes(personaId);
const strandCount = rebuildStrands(personaId);

// Write quality report
if (qualityIssues.length > 0 || enrichment.overallNotes) {
  const report = {
    personaId,
    reviewedAt: enrichment.reviewedAt,
    model: enrichment.model,
    overallNotes: enrichment.overallNotes ?? "",
    issues: qualityIssues,
  };
  const reportPath = path.join(personaDir(personaId), "quality-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Quality report: ${reportPath} (${qualityIssues.length} issues)`);
}

console.log(`\nDone:`);
console.log(`  Tags updated:     ${updatedTags}`);
console.log(`  Focus updated:    ${updatedFocus}`);
console.log(`  Summary updated:  ${updatedSummary}`);
console.log(`  Open loops:       ${updatedOpenLoops}`);
console.log(`  Decisions:        ${updatedDecisions}`);
console.log(`  Monthly indexes:  ${indexCount}`);
console.log(`  Strands:          ${strandCount}`);
console.log(`  Quality issues:   ${qualityIssues.length}`);
