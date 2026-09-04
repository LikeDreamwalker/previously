/**
 * WorldMemArena → Previously On Time Slice + Memory Node converter
 *
 * Reads WorldMemArena lifelong/personal JSON files and produces:
 *   1. Time slice .md files (YAML frontmatter + turn body)
 *   2. Memory node .md files (YAML frontmatter + markdown content)
 *   3. Monthly _index.json files
 *   4. Global tag-index.json
 *   5. Graph index.json
 *
 * Usage: node benchmark-data/convert.mjs
 * Output: benchmark-data/output/
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(__dirname, "worldmemarena", "lifelong", "personal");
const OUTPUT_DIR = path.join(__dirname, "output");

// ─── Helpers ────────────────────────────────────────────────────────────

/** Parse "Jan 09, 2025, 08:30:00" → Date */
function parseDate(str) {
  return new Date(str);
}

/** Date → "2025-01-09" */
function toSliceId(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Date → ISO 8601 */
function toISO(date) {
  return date.toISOString();
}

/** Slugify a string for use as node id */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Extract first sentence (up to 100 chars) for summary */
function extractSummary(text) {
  const firstSentence = text.split(/[.!?][\s\n]/)[0];
  if (!firstSentence) return text.slice(0, 100);
  return firstSentence.slice(0, 100);
}

/** Extract a few keywords from text to use as tags */
function extractSimpleTags(text) {
  const tagPatterns = [
    { regex: /\b(work|job|career|promotion|project|deadline|meeting|boss|colleague|office|salary|hire|fired)\b/i, tag: "work" },
    { regex: /\b(family|mom|dad|son|daughter|husband|wife|parent|kid|child|brother|sister|aunt|uncle|cousin|grandmother|grandfather)\b/i, tag: "family" },
    { regex: /\b(health|doctor|hospital|sick|pain|injury|surgery|medicine|therapy|mental|counseling|depression|anxiety|stress)\b/i, tag: "health" },
    { regex: /\b(money|budget|finance|debt|loan|salary|income|expense|rent|mortgage|bills|savings|cost|fee)\b/i, tag: "finance" },
    { regex: /\b(relationship|dating|boyfriend|girlfriend|partner|marriage|divorce|breakup|ex-|couple)\b/i, tag: "relationship" },
    { regex: /\b(travel|trip|vacation|holiday|flight|hotel|visit|destination)\b/i, tag: "travel" },
    { regex: /\b(study|school|college|university|degree|course|class|exam|learn|education|training|bootcamp)\b/i, tag: "education" },
    { regex: /\b(move|relocate|apartment|house|rent|lease|neighbor|neighborhood)\b/i, tag: "housing" },
    { regex: /\b(hobby|sport|soccer|running|hiking|gym|exercise|fitness|game|music|art|book|read|movie|film)\b/i, tag: "leisure" },
    { regex: /\b(goal|plan|future|dream|ambition|five.year|career.change)\b/i, tag: "goals" },
    { regex: /\b(environment|climate|sustainability|restoration|conservation|habitat|marine|ocean|water|shoreline|oyster)\b/i, tag: "environment" },
    { regex: /\b(politics|vote|election|council|government|policy|regulation|permit)\b/i, tag: "civic" },
  ];

  const tags = new Set();
  for (const { regex, tag } of tagPatterns) {
    if (regex.test(text)) tags.add(tag);
  }
  return [...tags].slice(0, 6);
}

/** Map WorldMemArena memory_type → Previously On NodeType */
function mapMemoryType(wmType) {
  const mapping = {
    "Event Memory": "experience",
    "Semantic Memory": "concept",
    "Preference Memory": "personality",
    "Procedural Memory": "concept",
    "Working Memory": "concept",
  };
  return mapping[wmType] ?? "concept";
}

/** Build a simple focus from session's first user message */
function deriveFocus(dialogue) {
  const firstUser = dialogue.find((t) => t.role === "user");
  if (!firstUser) return "conversation";
  return firstUser.content.slice(0, 80);
}

/** Generate a simple summary from the session's dialogue */
function deriveSummary(dialogue) {
  const userMessages = dialogue.filter((t) => t.role === "user").map((t) => t.content);
  const combined = userMessages.slice(0, 3).join(" ");
  return extractSummary(combined);
}

// ─── YAML / Markdown serializers ────────────────────────────────────────

/**
 * Simple YAML value serializer — handles strings, arrays, numbers, null.
 * No external dependency needed.
 */
function yamlValue(val, indent = 0) {
  const pad = "  ".repeat(indent);
  if (val === null || val === undefined) return "null";
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    return val.map((item) => `${pad}- ${yamlScalar(item)}`).join("\n");
  }
  return yamlScalar(val);
}

function yamlScalar(val) {
  const str = String(val);
  // Quote if it contains special chars
  if (/[":{}#&*!|>'"%@`[\]\n,\?\t]/.test(str) || str.startsWith("- ")) {
    return JSON.stringify(str);
  }
  return str;
}

function toYamlFrontmatter(obj) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (typeof value === "object" && !Array.isArray(value)) continue;
    const yamlVal = yamlValue(value, 1);
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      lines.push(yamlVal);
    } else {
      lines.push(`${key}: ${yamlVal}`);
    }
  }
  lines.push("---");
  lines.push(""); // blank line after frontmatter
  return lines.join("\n");
}

function serializeTimeSlice(slice) {
  const fm = {
    slice_id: slice.slice_id,
    focus: slice.focus,
    status: slice.status,
    start: slice.start,
    end: slice.end,
    timezone: slice.timezone,
    summary: slice.summary,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
    tags: slice.tags,
    related_slices: slice.related_slices,
    emotional_tone: slice.emotional_tone,
  };

  const frontmatter = toYamlFrontmatter(fm);
  const body = slice.turns
    .map(
      (turn, i) =>
        `## Turn ${i + 1} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`
    )
    .join("\n\n");

  return frontmatter + body + "\n";
}

function serializeMemoryNode(node) {
  const fm = {
    id: node.id,
    type: node.type,
    domain: node.domain,
    tags: node.tags,
    related: node.related,
    backlinks: node.backlinks,
    priority: node.priority,
    access_count: node.access_count,
    last_accessed: node.last_accessed,
    recall_conditions: node.recall_conditions,
    status: node.status,
    superseded_by: node.superseded_by,
  };

  const frontmatter = toYamlFrontmatter(fm);
  const content = `# ${node.title}\n\n${node.content}\n`;
  return frontmatter + content;
}

// ─── Core conversion logic ──────────────────────────────────────────────

function convertSample(rawData) {
  const sampleId = rawData.sample_id;
  console.log(`  Converting ${sampleId}...`);

  const slices = [];
  const memoryNodes = [];

  // ── Convert sessions → time slices ──────────────────────────────
  for (const session of rawData.sessions) {
    const sessionId = session._v2_session_id;
    const dialogue = session.dialogue;
    if (!dialogue || dialogue.length === 0) continue;

    const firstTimestamp = parseDate(dialogue[0].timestamp);
    const lastTimestamp = parseDate(dialogue[dialogue.length - 1].timestamp);
    const sliceId = toSliceId(firstTimestamp);

    // Build turns — skip attachment data, keep only text
    const turns = dialogue.map((turn) => ({
      timestamp: toISO(parseDate(turn.timestamp)),
      role: turn.role === "assistant" ? "agent" : "user",
      content: turn.content,
    }));

    // Derive metadata from session content
    const focus = deriveFocus(dialogue);
    const summary = deriveSummary(dialogue);
    const allText = dialogue.map((t) => t.content).join(" ");
    const tags = extractSimpleTags(allText);

    // Load memory points for this session to derive open_loops and decisions
    const sessionMemPoints = [];
    for (const mpGroup of rawData.memory_points) {
      if (mpGroup.session_id === sessionId) {
        sessionMemPoints.push(...mpGroup.memory_points);
      }
    }

    const openLoops = sessionMemPoints
      .filter((mp) => mp.is_update === "False" && mp.memory_source === "primary")
      .map((mp) => mp.memory_content.slice(0, 120))
      .slice(0, 5);

    const decisions = sessionMemPoints
      .filter((mp) => mp.is_update === "True")
      .map((mp) => mp.memory_content.slice(0, 120))
      .slice(0, 5);

    const allTags = [...new Set([...tags, ...sessionMemPoints.map((mp) => mp.memory_type?.toLowerCase().replace(/\s+/g, "-"))])];

    // Estimate tokens (rough: 4 chars ≈ 1 token)
    const estimatedTokens = Math.ceil(
      (turns.reduce((sum, t) => sum + t.content.length, 0) + focus.length + summary.length) / 4
    );

    const slice = {
      slice_id: sliceId,
      focus,
      status: "closed",
      start: turns[0].timestamp,
      end: turns[turns.length - 1].timestamp,
      timezone: "America/Los_Angeles", // Tacoma, WA
      summary,
      open_loops: openLoops,
      decisions,
      tags: allTags,
      related_slices: [],
      emotional_tone: "neutral",
      turns,
      estimatedTokens,
      closedBy: "time_silence",
      _sessionId: sessionId,
    };

    slices.push(slice);
  }

  // ── Convert memory_points → memory nodes ────────────────────────
  // Track update chains for superseded_by references
  const updateChain = {}; // original_memory → newest memory_id

  for (const mpGroup of rawData.memory_points) {
    for (const mp of mpGroup.memory_points) {
      const nodeId = `wm-${sampleId}-${mp.memory_id.toLowerCase()}`;
      const nodeType = mapMemoryType(mp.memory_type);
      const title = mp.memory_content.slice(0, 80);
      const priority = Math.round(mp.importance * 10) || 5;
      const lastAccessed = mp.timestamp ? mp.timestamp.slice(0, 10) : "2025-01-01";

      // Build recall conditions from memory content
      const words = mp.memory_content.toLowerCase().split(/\s+/).filter((w) => w.length > 4).slice(0, 4);
      const recallCondition = words.length > 0
        ? `query contains '${words.join("' or '")}'`
        : undefined;

      // Handle update chain
      let supersededBy = undefined;
      if (mp.is_update === "True" && mp.original_memories) {
        for (const orig of mp.original_memories) {
          const origSlug = slugify(orig);
          updateChain[origSlug] = nodeId;
        }
      }

      const node = {
        id: nodeId,
        type: nodeType,
        domain: sampleId,
        tags: [mp.memory_type?.toLowerCase().replace(/\s+/g, "-"), `session-${mp._session_id || mpGroup.session_id}`.toLowerCase()],
        related: [],
        backlinks: [],
        priority,
        access_count: 0,
        last_accessed: lastAccessed,
        recall_conditions: recallCondition ? [recallCondition] : [],
        status: "active",
        superseded_by: supersededBy,
        title,
        content: mp.memory_content,
        _importance: mp.importance,
        _is_update: mp.is_update,
        _memory_id: mp.memory_id,
      };

      memoryNodes.push(node);
    }
  }

  // Resolve update chains: if A is superseded by B and B is superseded by C, A should point to C
  for (const node of memoryNodes) {
    if (node.superseded_by) {
      let current = node.superseded_by;
      const visited = new Set();
      while (visited.size < 10) {
        visited.add(current);
        const next = memoryNodes.find((n) => n.id === current);
        if (!next || !next.superseded_by) break;
        if (visited.has(next.superseded_by)) break; // cycle
        current = next.superseded_by;
      }
      node.superseded_by = current;
    }
  }

  return { sampleId, slices, memoryNodes };
}

// ─── Build indices ──────────────────────────────────────────────────────

function buildMonthlyIndices(slices) {
  // Group slices by year-month
  const byMonth = {};
  for (const slice of slices) {
    const [year, month] = slice.slice_id.split("-");
    const key = `${year}-${month}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(slice);
  }

  const indices = {};
  for (const [month, monthSlices] of Object.entries(byMonth)) {
    const entries = monthSlices
      .map((s) => ({
        id: s.slice_id.split("-")[2],
        focus: s.focus,
        summary: s.summary,
        tags: s.tags,
        status: s.status,
        start: s.start,
        open_loops: s.open_loops,
        decisions: s.decisions,
      }))
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    indices[month] = {
      month,
      slices: entries,
    };
  }

  return indices;
}

function buildTagIndex(slices) {
  const tagIndex = {};
  for (const slice of slices) {
    const [year, month, day] = slice.slice_id.split("-");
    const relPath = `${year}/${month}/${day}`;
    for (const tag of slice.tags) {
      if (!tagIndex[tag]) tagIndex[tag] = [];
      if (!tagIndex[tag].includes(relPath)) {
        tagIndex[tag].push(relPath);
      }
    }
  }
  return tagIndex;
}

function buildGraphIndex(memoryNodes) {
  const nodes = {};
  for (const node of memoryNodes) {
    const nodePath = `memory/nodes/${node.type}s/${slugify(node.title)}.md`;
    nodes[node.id] = {
      path: nodePath,
      type: node.type,
      tags: node.tags,
      links: node.related,
      backlinks: node.backlinks,
      priority: node.priority,
      access_count: node.access_count,
      last_accessed: node.last_accessed,
      status: node.status,
    };
    if (node.superseded_by) {
      nodes[node.id].superseded_by = node.superseded_by;
    }
  }
  return { nodes };
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== WorldMemArena → Previously On Converter ===\n");

  // Find all JSON files
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`Found ${files.length} sample files\n`);

  const allSlices = [];
  const allMemoryNodes = [];

  for (const file of files) {
    const filePath = path.join(INPUT_DIR, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    const { sampleId, slices, memoryNodes } = convertSample(data);

    allSlices.push(...slices);
    allMemoryNodes.push(...memoryNodes);

    console.log(
      `    ${sampleId}: ${slices.length} slices, ${memoryNodes.length} nodes`
    );
  }

  console.log(`\nTotal: ${allSlices.length} slices, ${allMemoryNodes.length} memory nodes`);

  // ── Write time slices ────────────────────────────────────────────
  console.log("\nWriting time slices...");
  let sliceCount = 0;
  for (const slice of allSlices) {
    const [year, month] = slice.slice_id.split("-");
    const dir = path.join(OUTPUT_DIR, "memory", "episodic", "slices", year, month);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${slice.slice_id.split("-")[2]}.md`);
    const content = serializeTimeSlice(slice);
    fs.writeFileSync(filePath, content, "utf-8");
    sliceCount++;
  }
  console.log(`  Wrote ${sliceCount} time slice .md files`);

  // ── Write monthly indices ────────────────────────────────────────
  console.log("Writing monthly indices...");
  const monthlyIndices = buildMonthlyIndices(allSlices);
  for (const [month, index] of Object.entries(monthlyIndices)) {
    const [year, monthNum] = month.split("-");
    const dir = path.join(OUTPUT_DIR, "memory", "episodic", "slices", year, monthNum);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "_index.json");
    fs.writeFileSync(filePath, JSON.stringify(index, null, 2), "utf-8");
  }
  console.log(`  Wrote ${Object.keys(monthlyIndices).length} monthly _index.json files`);

  // ── Write tag index ──────────────────────────────────────────────
  console.log("Writing tag index...");
  const tagIndex = buildTagIndex(allSlices);
  const tagIndexDir = path.join(OUTPUT_DIR, "memory", "episodic");
  fs.mkdirSync(tagIndexDir, { recursive: true });
  fs.writeFileSync(
    path.join(tagIndexDir, "tag-index.json"),
    JSON.stringify(tagIndex, null, 2),
    "utf-8"
  );
  console.log(`  Wrote tag-index.json (${Object.keys(tagIndex).length} tags)`);

  // ── Write memory nodes ───────────────────────────────────────────
  console.log("Writing memory nodes...");
  let nodeCount = 0;
  for (const node of allMemoryNodes) {
    const typeDir = node.type === "experience" ? "experience" :
                    node.type === "concept" ? "concepts" :
                    node.type === "project" ? "projects" :
                    node.type === "people" ? "people" :
                    "personalities";

    const dir = path.join(OUTPUT_DIR, "memory", "nodes", typeDir);
    fs.mkdirSync(dir, { recursive: true });

    const fileName = slugify(node.title) + ".md";
    const filePath = path.join(dir, fileName);
    const content = serializeMemoryNode(node);
    fs.writeFileSync(filePath, content, "utf-8");
    nodeCount++;
  }
  console.log(`  Wrote ${nodeCount} memory node .md files`);

  // ── Write graph index ────────────────────────────────────────────
  console.log("Writing graph index...");
  const graphIndex = buildGraphIndex(allMemoryNodes);
  const graphDir = path.join(OUTPUT_DIR, "memory", "graph");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(
    path.join(graphDir, "index.json"),
    JSON.stringify(graphIndex, null, 2),
    "utf-8"
  );
  console.log(`  Wrote graph/index.json (${Object.keys(graphIndex.nodes).length} nodes)`);

  // ── Write QA checkpoints (for later benchmarking) ────────────────
  console.log("Preserving QA checkpoints...");
  const qaDir = path.join(OUTPUT_DIR, "qa-checkpoints");
  fs.mkdirSync(qaDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(INPUT_DIR, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data.qa_checkpoints && data.qa_checkpoints.length > 0) {
      const qaFile = path.join(qaDir, `${data.sample_id}_qa.json`);
      fs.writeFileSync(qaFile, JSON.stringify(data.qa_checkpoints, null, 2), "utf-8");
    }
  }
  console.log(`  Preserved QA checkpoints for ${files.length} samples`);

  // ── Summary ──────────────────────────────────────────────────────
  const outputSize = getDirSize(OUTPUT_DIR);
  console.log(`\n=== Done ===`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Total size: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);
}

function getDirSize(dir) {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += fs.statSync(fullPath).size;
    }
  }
  return size;
}

main().catch((err) => {
  console.error("Conversion failed:", err);
  process.exit(1);
});
