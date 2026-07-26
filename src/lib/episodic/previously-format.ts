/**
 * Previously.md format definition, migration, and validation.
 *
 * Pure functions only — no I/O, no LLM calls, no Node dependencies.
 *
 * New format (v2): long-term vs short-term memory split.
 * Old format (v1): 3-section flat list (User identity / User patterns / Agent strategies).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface PreviouslyBelief {
  /** Full belief text. */
  text: string;
  /** Evidence references: slice paths. */
  evidence: string[];
  /** high / medium / low. Only for long-term memory. */
  confidence?: "high" | "medium" | "low";
  /** ISO 8601 date of last modification. */
  updated: string;
  /** ISO 8601 expiry date. Required for short-term. */
  expires?: string;
  /** Observation count. */
  obs?: number;
  /** If superseded, reference to the new belief. */
  superseded_by?: string;
}

export interface PreviouslyDocument {
  sliceId: string;
  updated: string;
  longTerm: {
    identity: PreviouslyBelief[];
    patterns: PreviouslyBelief[];
    strategies: PreviouslyBelief[];
  };
  shortTerm: {
    context: PreviouslyBelief[];
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────

export const SECTION_LONG_TERM = "## 长期记忆";
export const SECTION_SHORT_TERM = "## 短期记忆";

export const SUBSECTION_IDENTITY = "### User identity";
export const SUBSECTION_PATTERNS = "### User patterns";
export const SUBSECTION_STRATEGIES = "### Agent strategies";
export const SUBSECTION_CONTEXT = "### Current context";

const COMMENT_LONG_TERM = "<!-- 不衰减。仅用户纠正或 contradict 时修改。 -->";
const COMMENT_SHORT_TERM =
  "<!-- 默认 7 天过期。每次审查重新评估 relevance。 -->";

// Old section headers for migration.
const OLD_IDENTITY = "## User identity";
const OLD_PATTERNS = "## User patterns";
const OLD_STRATEGIES = "## Agent strategies";

/** Default short-term expiry: 7 days from now. */
export const DEFAULT_SHORT_TERM_EXPIRY_DAYS = 7;

// ─── Serialization ──────────────────────────────────────────────────────

/** Format an ISO date string for a belief's `updated` field (date only). */
export function formatDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Format an ISO date string for a belief's `expires` field (date only). */
export function formatExpiry(daysFromNow: number = DEFAULT_SHORT_TERM_EXPIRY_DAYS): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/** Serialize a single belief to its markdown representation. */
export function serializeBelief(b: PreviouslyBelief, isShortTerm: boolean): string {
  const lines: string[] = [];
  lines.push(`- ${b.text}`);

  const meta: string[] = [];
  if (b.evidence.length > 0) {
    meta.push(`evidence: [${b.evidence.join("], [")}]`);
  }
  if (b.confidence && !isShortTerm) {
    meta.push(`confidence: ${b.confidence}`);
  }
  meta.push(`updated: ${b.updated}`);
  if (b.obs !== undefined && b.obs > 0) {
    meta.push(`obs: ${b.obs}`);
  }
  if (isShortTerm && b.expires) {
    meta.push(`expires: ${b.expires}`);
  }
  if (b.superseded_by) {
    meta.push(`superseded_by: ${b.superseded_by}`);
  }

  lines.push(`  ${meta.join(" | ")}`);
  return lines.join("\n");
}

/** Serialize a full PreviouslyDocument to markdown. */
export function serializePreviously(doc: PreviouslyDocument): string {
  const lines: string[] = [];

  // Header
  lines.push("# Previously On");
  lines.push("");
  lines.push(`_Active slice: ${doc.sliceId} | Updated: ${doc.updated}_`);
  lines.push("");

  // Long-term memory
  lines.push(SECTION_LONG_TERM);
  lines.push(COMMENT_LONG_TERM);
  lines.push("");

  lines.push(SUBSECTION_IDENTITY);
  if (doc.longTerm.identity.length === 0) {
    lines.push("");
    lines.push("_No beliefs yet._");
  } else {
    for (const b of doc.longTerm.identity) {
      lines.push("");
      lines.push(serializeBelief(b, false));
    }
  }
  lines.push("");

  lines.push(SUBSECTION_PATTERNS);
  if (doc.longTerm.patterns.length === 0) {
    lines.push("");
    lines.push("_No beliefs yet._");
  } else {
    for (const b of doc.longTerm.patterns) {
      lines.push("");
      lines.push(serializeBelief(b, false));
    }
  }
  lines.push("");

  lines.push(SUBSECTION_STRATEGIES);
  if (doc.longTerm.strategies.length === 0) {
    lines.push("");
    lines.push("_No beliefs yet._");
  } else {
    for (const b of doc.longTerm.strategies) {
      lines.push("");
      lines.push(serializeBelief(b, false));
    }
  }
  lines.push("");

  // Short-term memory
  lines.push(SECTION_SHORT_TERM);
  lines.push(COMMENT_SHORT_TERM);
  lines.push("");

  lines.push(SUBSECTION_CONTEXT);
  if (doc.shortTerm.context.length === 0) {
    lines.push("");
    lines.push("_No beliefs yet._");
  } else {
    for (const b of doc.shortTerm.context) {
      lines.push("");
      lines.push(serializeBelief(b, true));
    }
  }

  return lines.join("\n") + "\n";
}

/** Create an empty previously.md document for a new slice. */
export function newPreviouslyTemplate(sliceId: string): string {
  return serializePreviously({
    sliceId,
    updated: new Date().toISOString(),
    longTerm: { identity: [], patterns: [], strategies: [] },
    shortTerm: { context: [] },
  });
}

// ─── Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a serialized previously.md body into a PreviouslyDocument.
 * Returns null if the content doesn't match the expected format.
 */
export function parsePreviously(content: string): PreviouslyDocument | null {
  try {
    const lines = content.split("\n");

    // Parse header
    const headerMatch = content.match(/_Active slice: ([^\s|]+).*?Updated: (.+?)_/);
    if (!headerMatch) return null;
    const sliceId = headerMatch[1].trim();
    const updated = headerMatch[2].trim();

    const doc: PreviouslyDocument = {
      sliceId,
      updated,
      longTerm: { identity: [], patterns: [], strategies: [] },
      shortTerm: { context: [] },
    };

    // Split into sections
    const ltSection = extractSection(content, SECTION_LONG_TERM, SECTION_SHORT_TERM);
    const stSection = extractSection(content, SECTION_SHORT_TERM, null);

    if (ltSection) {
      doc.longTerm.identity = parseBeliefsFromSubsection(ltSection, SUBSECTION_IDENTITY);
      doc.longTerm.patterns = parseBeliefsFromSubsection(ltSection, SUBSECTION_PATTERNS);
      doc.longTerm.strategies = parseBeliefsFromSubsection(ltSection, SUBSECTION_STRATEGIES);
    }

    if (stSection) {
      doc.shortTerm.context = parseBeliefsFromSubsection(stSection, SUBSECTION_CONTEXT);
    }

    return doc;
  } catch {
    return null;
  }
}

/** Extract the text between two section headers. If endHeader is null, goes to EOF. */
function extractSection(
  content: string,
  startHeader: string,
  endHeader: string | null,
): string | null {
  const startIdx = content.indexOf(startHeader);
  if (startIdx === -1) return null;

  const afterStart = content.slice(startIdx + startHeader.length);
  if (endHeader === null) return afterStart;

  const endIdx = afterStart.indexOf(endHeader);
  if (endIdx === -1) return afterStart;

  return afterStart.slice(0, endIdx);
}

/** Parse belief entries from a subsection body. */
function parseBeliefsFromSubsection(content: string, subsectionHeader: string): PreviouslyBelief[] {
  const section = extractSection(content, subsectionHeader, "### ");
  if (!section) return [];

  const beliefs: PreviouslyBelief[] = [];
  const lines = section.split("\n");

  let currentText: string | null = null;
  let currentMeta: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, and placeholders
    if (trimmed === "" || trimmed.startsWith("<!--") || trimmed === "_No beliefs yet._") {
      continue;
    }

    // Start of a new belief
    if (trimmed.startsWith("- ")) {
      // Save previous belief
      if (currentText) {
        const belief = parseBeliefFromTextAndMeta(currentText, currentMeta);
        if (belief) beliefs.push(belief);
      }
      currentText = trimmed.slice(2).trim();
      currentMeta = null;
      continue;
    }

    // Meta line (indented)
    if (currentText && trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("- ")) {
      currentMeta = trimmed;
      continue;
    }

    // A non-meta, non-belief line — end of subsection
    if (trimmed.startsWith("### ") || trimmed.startsWith("## ")) {
      break;
    }
  }

  // Don't forget the last belief
  if (currentText) {
    const belief = parseBeliefFromTextAndMeta(currentText, currentMeta);
    if (belief) beliefs.push(belief);
  }

  return beliefs;
}

/** Parse a single belief from its text and meta line. */
function parseBeliefFromTextAndMeta(
  text: string,
  meta: string | null,
): PreviouslyBelief | null {
  const belief: PreviouslyBelief = {
    text,
    evidence: [],
    updated: formatDate(),
  };

  if (meta) {
    // Parse key: value pairs separated by " | "
    const pairs = meta.split("|").map((s) => s.trim());

    for (const pair of pairs) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx === -1) continue;
      const key = pair.slice(0, colonIdx).trim();
      const value = pair.slice(colonIdx + 1).trim();

      switch (key) {
        case "evidence":
          // Parse [ref1], [ref2] format
          belief.evidence = parseEvidenceList(value);
          break;
        case "confidence":
          if (value === "high" || value === "medium" || value === "low") {
            belief.confidence = value;
          }
          break;
        case "updated":
          belief.updated = value;
          break;
        case "expires":
          belief.expires = value;
          break;
        case "obs":
          belief.obs = parseInt(value, 10) || 0;
          break;
        case "superseded_by":
          belief.superseded_by = value;
          break;
      }
    }
  }

  return belief;
}

/** Parse "[ref1], [ref2], [ref3]" into string array. */
function parseEvidenceList(value: string): string[] {
  const refs: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let match;
  while ((match = re.exec(value)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

// ─── Validation ─────────────────────────────────────────────────────────

/** Validate a previously.md body string against the format spec. */
export function validatePreviouslyFormat(content: string): ValidationResult {
  const errors: string[] = [];

  // Check required sections exist
  if (!content.includes(SECTION_LONG_TERM)) {
    errors.push(`Missing section: ${SECTION_LONG_TERM}`);
  }
  if (!content.includes(SECTION_SHORT_TERM)) {
    errors.push(`Missing section: ${SECTION_SHORT_TERM}`);
  }

  // Check required subsections
  const requiredSubsections = [
    SUBSECTION_IDENTITY,
    SUBSECTION_PATTERNS,
    SUBSECTION_STRATEGIES,
    SUBSECTION_CONTEXT,
  ];
  for (const sub of requiredSubsections) {
    if (!content.includes(sub)) {
      errors.push(`Missing subsection: ${sub}`);
    }
  }

  // Check header
  if (!/_Active slice:/.test(content)) {
    errors.push("Missing active slice header");
  }

  // Parse and validate each belief
  const doc = parsePreviously(content);
  if (doc) {
    const allBeliefs = [
      ...doc.longTerm.identity,
      ...doc.longTerm.patterns,
      ...doc.longTerm.strategies,
      ...doc.shortTerm.context,
    ];

    for (let i = 0; i < allBeliefs.length; i++) {
      const b = allBeliefs[i];
      if (!b.text.trim()) {
        errors.push(`Belief #${i + 1}: empty text`);
      }
      if (!b.updated) {
        errors.push(`Belief #${i + 1}: missing updated date`);
      }
    }

    // Short-term beliefs must have expires
    for (let i = 0; i < doc.shortTerm.context.length; i++) {
      const b = doc.shortTerm.context[i];
      if (!b.expires) {
        errors.push(`Short-term belief #${i + 1}: missing expires date`);
      }
    }
  } else {
    errors.push("Could not parse previously.md content");
  }

  return { valid: errors.length === 0, errors };
}

// ─── Migration (v1 → v2) ────────────────────────────────────────────────

/**
 * Migrate from old 3-section format to new long/short-term format.
 *
 * Heuristics:
 *   - User identity items → longTerm.identity (user-stated facts are permanent)
 *   - User patterns with obs ≥ 3 OR confidence: high → longTerm.patterns
 *   - User patterns with obs < 3 AND confidence: medium/low → shortTerm.context
 *   - Agent strategies that appear to be reusable (obs ≥ 2) → longTerm.strategies
 *   - Agent strategies that are one-off (obs: 1 or absent) → dropped
 */
export function migrateToLongShortFormat(
  content: string,
  currentSliceId?: string,
): string {
  // If already v2 format, return as-is
  if (content.includes(SECTION_LONG_TERM) && content.includes(SECTION_SHORT_TERM)) {
    return content;
  }

  const sliceId =
    currentSliceId ??
    (content.match(/_Active slice: (.+?) [|]/)?.[1] ?? "unknown");

  // Parse old sections
  const identityItems = parseOldSection(content, OLD_IDENTITY);
  const patternItems = parseOldSection(content, OLD_PATTERNS);
  const strategyItems = parseOldSection(content, OLD_STRATEGIES);

  const doc: PreviouslyDocument = {
    sliceId,
    updated: new Date().toISOString(),
    longTerm: { identity: [], patterns: [], strategies: [] },
    shortTerm: { context: [] },
  };

  // User identity → always long-term
  for (const item of identityItems) {
    doc.longTerm.identity.push(itemToBelief(item, "long"));
  }

  // User patterns → long-term if obs ≥ 3 or confidence: high
  for (const item of patternItems) {
    const obs = extractObs(item.meta);
    const conf = extractConfidence(item.meta);
    if (obs >= 3 || conf === "high") {
      doc.longTerm.patterns.push(itemToBelief(item, "long"));
    } else {
      doc.shortTerm.context.push(itemToBelief(item, "short"));
    }
  }

  // Agent strategies → long-term if obs ≥ 2 (reusable), drop one-offs
  for (const item of strategyItems) {
    const obs = extractObs(item.meta);
    if (obs >= 2) {
      doc.longTerm.strategies.push(itemToBelief(item, "long"));
    }
    // obs < 2: drop (one-off technique, not a strategy)
  }

  return serializePreviously(doc);
}

interface OldBeliefItem {
  text: string;
  meta: string;
}

/** Parse old-style section: bullet lines + their annotation lines. */
function parseOldSection(content: string, sectionHeader: string): OldBeliefItem[] {
  const section = extractSection(content, sectionHeader, "## ");
  if (!section) return [];

  const items: OldBeliefItem[] = [];
  const lines = section.split("\n");
  let currentText: string | null = null;
  let currentMeta: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "_No beliefs yet._" || trimmed.startsWith("<!--")) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (currentText) {
        items.push({ text: currentText, meta: currentMeta ?? "" });
      }
      currentText = trimmed.slice(2).trim();
      currentMeta = null;
      continue;
    }

    if (currentText && trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("- ")) {
      currentMeta = trimmed;
      continue;
    }

    // Stop at next section
    if (trimmed.startsWith("## ")) break;
  }

  if (currentText) {
    items.push({ text: currentText, meta: currentMeta ?? "" });
  }

  return items;
}

/** Extract observation count from old-style meta line. */
function extractObs(meta: string): number {
  const match = meta.match(/观察: (\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Extract confidence level from old-style meta line. */
function extractConfidence(meta: string): "high" | "medium" | "low" | null {
  const match = meta.match(/置信度: (高|中|低)/);
  if (!match) return null;
  switch (match[1]) {
    case "高": return "high";
    case "中": return "medium";
    case "低": return "low";
    default: return null;
  }
}

/** Extract the first date reference from old-style meta (for evidence). */
function extractFirstDate(meta: string): string | null {
  const match = meta.match(/(\d{4}[-\/]\d{2}[-\/]\d{2}[-\/]\d{4})/);
  return match ? match[1].replace(/-/g, "/") : null;
}

/** Convert an old-style belief item to a new PreviouslyBelief. */
function itemToBelief(
  item: OldBeliefItem,
  tier: "long" | "short",
): PreviouslyBelief {
  const evidence: string[] = [];
  const dateRef = extractFirstDate(item.meta);
  if (dateRef) evidence.push(dateRef);

  const belief: PreviouslyBelief = {
    text: item.text,
    evidence,
    updated: formatDate(),
  };

  if (tier === "long") {
    const conf = extractConfidence(item.meta);
    belief.confidence = conf ?? "medium";
    const obs = extractObs(item.meta);
    if (obs > 0) belief.obs = obs;
  } else {
    belief.expires = formatExpiry();
    const obs = extractObs(item.meta);
    if (obs > 0) belief.obs = obs;
  }

  return belief;
}
