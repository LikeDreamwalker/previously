/**
 * Previously.md format definition, serialization, parsing, validation, and
 * legacy migration.
 *
 * v3 format — two-section archive, written in English:
 *   1. User profile — a third-person, framework-based inference model
 *      of the user (NOT episodic event memory). Fixed dimensions.
 *   2. Self-model — operating lessons distilled from the agent's own timeline
 *      (agent.md): tool discipline, reasoning, answer form, recurring errors,
 *      recall discipline, corrections.
 *
 * Every entry = a distilled claim + `refs` pointers to the evidence (slice /
 * agent.md refs) + confidence + obs. Reference logic, not compression logic:
 * the raw evidence stays in the slices; previously.md only points at it.
 *
 * Pure functions only — no I/O, no LLM calls, no Node dependencies.
 */

// ─── Dimensions ────────────────────────────────────────────────────────────

/** Fixed profile dimensions — the model may write into these but not invent new ones. */
export const PROFILE_DIMENSIONS = [
  "identity",
  "personality",
  "communication",
  "cognition",
  "knowledge",
  "values",
  "work_style",
  "goals",
  "current_state",
  "boundaries",
] as const;
export type ProfileDimension = (typeof PROFILE_DIMENSIONS)[number];

/** Fixed self-model dimensions — operating lessons from the agent's timeline. */
export const SELF_MODEL_DIMENSIONS = [
  "tool_discipline",
  "reasoning",
  "answer_form",
  "recurring_errors",
  "recall_discipline",
  "corrections",
] as const;
export type SelfModelDimension = (typeof SELF_MODEL_DIMENSIONS)[number];

export type Section = "profile" | "self_model";

export const PROFILE_DIMENSION_LABELS: Record<ProfileDimension, string> = {
  identity: "Identity & background",
  personality: "Personality & decision style",
  communication: "Communication preferences",
  cognition: "Cognitive style",
  knowledge: "Domain knowledge",
  values: "Values & priorities",
  work_style: "Work style",
  goals: "Goals & direction",
  current_state: "Current state",
  boundaries: "Boundaries & sensitivities",
};

export const SELF_MODEL_DIMENSION_LABELS: Record<SelfModelDimension, string> = {
  tool_discipline: "Tool discipline",
  reasoning: "Reasoning & decomposition",
  answer_form: "Answer form",
  recurring_errors: "Recurring errors",
  recall_discipline: "Recall discipline",
  corrections: "Corrections",
};

/** Label (Chinese subsection header) → dimension key, for parsing. */
export const PROFILE_LABEL_TO_KEY: Record<string, ProfileDimension> = {};
for (const d of PROFILE_DIMENSIONS) PROFILE_LABEL_TO_KEY[PROFILE_DIMENSION_LABELS[d]] = d;
export const SELF_MODEL_LABEL_TO_KEY: Record<string, SelfModelDimension> = {};
for (const d of SELF_MODEL_DIMENSIONS) SELF_MODEL_LABEL_TO_KEY[SELF_MODEL_DIMENSION_LABELS[d]] = d;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreviouslyBelief {
  /** Full belief text. */
  text: string;
  /** Evidence pointers: slice-turn refs like "2026/07/26/1539-esXr7w" or "agent.md 2026/08/05/1403". */
  refs: string[];
  /** high / medium / low. */
  confidence?: "high" | "medium" | "low";
  /** ISO 8601 date of last modification. */
  updated: string;
  /** ISO 8601 expiry date — only for short-lived entries (current_state, boundaries). */
  expires?: string;
  /** Observation count. */
  obs?: number;
  /** If superseded, reference to the new belief. */
  superseded_by?: string;
  /** If refuted (e.g. by a user correction), the note about what refuted it. */
  refuted_by?: string;
}

export interface PreviouslyDocument {
  sliceId: string;
  updated: string;
  profile: Partial<Record<ProfileDimension, PreviouslyBelief[]>>;
  selfModel: Partial<Record<SelfModelDimension, PreviouslyBelief[]>>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Section / format markers ───────────────────────────────────────────────

export const SECTION_PROFILE = "## User profile";
export const SECTION_SELF_MODEL = "## Self-model";
export const FORMAT_STAMP = "Format: user profile + self-model";

// Legacy markers for migration detection.
const LEGACY_LONG_TERM = "## 长期记忆";
const LEGACY_SHORT_TERM = "## 短期记忆";
const LEGACY_IDENTITY = "## User identity";
const LEGACY_PATTERNS = "## User patterns";
const LEGACY_STRATEGIES = "## Agent strategies";

// ─── Date helpers ───────────────────────────────────────────────────────────

/** Default short-term expiry: 14 days from now. */
export const DEFAULT_SHORT_TERM_EXPIRY_DAYS = 14;

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

// ─── Serialization ──────────────────────────────────────────────────────────

/** Serialize a single belief to its markdown representation. */
export function serializeBelief(b: PreviouslyBelief): string {
  const lines: string[] = [];
  lines.push(`- ${b.text}`);

  const meta: string[] = [];
  if (b.refs.length > 0) {
    meta.push(`refs: ${b.refs.map((r) => `[${r}]`).join(", ")}`);
  }
  if (b.confidence) meta.push(`confidence: ${b.confidence}`);
  meta.push(`updated: ${b.updated}`);
  if (b.obs !== undefined && b.obs > 0) meta.push(`obs: ${b.obs}`);
  if (b.expires) meta.push(`expires: ${b.expires}`);
  if (b.superseded_by) meta.push(`superseded_by: ${b.superseded_by}`);
  if (b.refuted_by) meta.push(`refuted_by: ${b.refuted_by}`);

  lines.push(`  ${meta.join(" | ")}`);
  return lines.join("\n");
}

/** Serialize a full PreviouslyDocument to markdown. Empty subsections are omitted. */
export function serializePreviously(doc: PreviouslyDocument): string {
  const lines: string[] = [];

  lines.push("# Previously On", "");
  // Format stamp before Updated so the legacy header regex still captures the ISO date.
  lines.push(`_Active slice: ${doc.sliceId} | ${FORMAT_STAMP} | Updated: ${doc.updated}_`, "");

  // Section 1 — user profile
  lines.push(SECTION_PROFILE, "");
  for (const dim of PROFILE_DIMENSIONS) {
    const beliefs = doc.profile[dim] ?? [];
    if (beliefs.length === 0) continue;
    lines.push(`### ${PROFILE_DIMENSION_LABELS[dim]}`, "");
    for (const b of beliefs) {
      lines.push(serializeBelief(b), "");
    }
  }

  // Section 2 — self-model
  lines.push(SECTION_SELF_MODEL, "");
  for (const dim of SELF_MODEL_DIMENSIONS) {
    const beliefs = doc.selfModel[dim] ?? [];
    if (beliefs.length === 0) continue;
    lines.push(`### ${SELF_MODEL_DIMENSION_LABELS[dim]}`, "");
    for (const b of beliefs) {
      lines.push(serializeBelief(b), "");
    }
  }

  // Collapse 3+ consecutive blank lines to 2, and trim trailing blank lines.
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return joined + "\n";
}

/** Create an empty previously.md document (v3 template). */
export function newPreviouslyTemplate(sliceId: string): string {
  return serializePreviously({
    sliceId,
    updated: new Date().toISOString(),
    profile: {},
    selfModel: {},
  });
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Detect v3 format. */
export function isV3Format(content: string): boolean {
  return (
    content.includes("## User profile") && content.includes("## Self-model")
  );
}

/** Detect legacy v2 format (长期记忆 / 短期记忆). */
export function isV2Format(content: string): boolean {
  return content.includes(LEGACY_LONG_TERM) || content.includes(LEGACY_SHORT_TERM);
}

/** Parse a refs/evidence list like "[a], [b]" into a string array. */
function parseRefList(value: string): string[] {
  const refs: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/** Parse a meta line into a belief's fields. Tolerant of both v3 and legacy keys. */
function parseMetaInto(metaLine: string, belief: PreviouslyBelief): void {
  const pairs = metaLine.split("|").map((s) => s.trim());
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const key = pair.slice(0, colonIdx).trim().toLowerCase();
    const value = pair.slice(colonIdx + 1).trim();
    switch (key) {
      case "refs":
      case "evidence":
        belief.refs = parseRefList(value);
        break;
      case "confidence":
      case "置信度": {
        const c = value.toLowerCase();
        if (c === "high" || c === "medium" || c === "low") belief.confidence = c;
        else if (c === "高") belief.confidence = "high";
        else if (c === "中") belief.confidence = "medium";
        else if (c === "低") belief.confidence = "low";
        break;
      }
      case "updated":
        belief.updated = value;
        break;
      case "expires":
        belief.expires = value;
        break;
      case "obs":
      case "观察":
        belief.obs = parseInt(value, 10) || 0;
        break;
      case "superseded_by":
        belief.superseded_by = value;
        break;
      case "refuted_by":
        belief.refuted_by = value;
        break;
      default:
        break;
    }
  }
}

/**
 * Parse a serialized v3 previously.md body into a PreviouslyDocument.
 * Returns null for legacy (v1/v2) content — run `migrateToV3` for those.
 */
export function parsePreviously(content: string): PreviouslyDocument | null {
  if (!isV3Format(content)) return null;

  const headerMatch = content.match(/_Active slice: ([^\s|]+).*?Updated: (.+?)_/);
  const sliceId = headerMatch?.[1]?.trim() ?? "";
  const updated = headerMatch?.[2]?.trim() ?? new Date().toISOString();

  const doc: PreviouslyDocument = { sliceId, updated, profile: {}, selfModel: {} };

  let currentSection: Section | null = null;
  let currentDim: ProfileDimension | SelfModelDimension | null = null;
  let currentBelief: PreviouslyBelief | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("## User profile")) {
      currentSection = "profile";
      currentDim = null;
      currentBelief = null;
      continue;
    }
    if (trimmed.startsWith("## Self-model")) {
      currentSection = "self_model";
      currentDim = null;
      currentBelief = null;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      currentSection = null;
      currentDim = null;
      currentBelief = null;
      continue;
    }

    if (currentSection && trimmed.startsWith("### ")) {
      const label = trimmed.slice(4).trim();
      currentDim =
        currentSection === "profile"
          ? (PROFILE_LABEL_TO_KEY[label] ?? null)
          : (SELF_MODEL_LABEL_TO_KEY[label] ?? null);
      currentBelief = null;
      continue;
    }

    // Skip blank lines, comments, and the header/stamp lines.
    if (
      trimmed === "" ||
      trimmed.startsWith("<!--") ||
      trimmed.startsWith("_") ||
      trimmed.startsWith("#")
    ) {
      continue;
    }

    // A belief bullet.
    if (currentSection && currentDim && trimmed.startsWith("- ")) {
      const belief: PreviouslyBelief = {
        text: trimmed.slice(2).trim(),
        refs: [],
        updated: formatDate(),
      };
      const arr =
        currentSection === "profile"
          ? (doc.profile[currentDim as ProfileDimension] =
              doc.profile[currentDim as ProfileDimension] ?? [])
          : (doc.selfModel[currentDim as SelfModelDimension] =
              doc.selfModel[currentDim as SelfModelDimension] ?? []);
      arr.push(belief);
      currentBelief = belief;
      continue;
    }

    // Meta line (indented) — attach to the current belief.
    if (currentBelief && trimmed && line.startsWith(" ")) {
      parseMetaInto(trimmed, currentBelief);
    }
  }

  return doc;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Validate a v3 previously.md body string against the format spec. */
export function validatePreviouslyFormat(content: string): ValidationResult {
  const errors: string[] = [];

  if (!content.includes("## User profile")) {
    errors.push("Missing section: User profile");
  }
  if (!content.includes("## Self-model")) {
    errors.push("Missing section: Self-model");
  }
  if (!/_Active slice:/.test(content)) {
    errors.push("Missing active slice header");
  }

  const doc = parsePreviously(content);
  if (!doc) {
    errors.push("Could not parse previously.md content (not v3 format)");
    return { valid: errors.length === 0, errors };
  }

  // Validate every entry: non-empty text + at least one ref.
  const allBeliefs: Array<{ where: string; belief: PreviouslyBelief }> = [];
  for (const dim of PROFILE_DIMENSIONS) {
    for (const b of doc.profile[dim] ?? []) {
      allBeliefs.push({ where: `profile>${PROFILE_DIMENSION_LABELS[dim]}`, belief: b });
    }
  }
  for (const dim of SELF_MODEL_DIMENSIONS) {
    for (const b of doc.selfModel[dim] ?? []) {
      allBeliefs.push({ where: `self_model>${SELF_MODEL_DIMENSION_LABELS[dim]}`, belief: b });
    }
  }

  allBeliefs.forEach(({ where, belief }, i) => {
    if (!belief.text.trim()) {
      errors.push(`${where} entry #${i + 1}: empty text`);
    }
    if (!belief.updated) {
      errors.push(`${where} entry #${i + 1}: missing updated date`);
    }
    if (belief.refs.length === 0) {
      errors.push(`${where} entry #${i + 1}: missing refs (every entry must cite evidence)`);
    }
  });

  return { valid: errors.length === 0, errors };
}

// ─── Legacy migration (v1 / v2 → v3) ─────────────────────────────────────────

/**
 * Parse legacy (v1/v2) belief bullets + meta lines from a section body.
 * Returns { text, meta } pairs; v1/v2 use the same bullet + indented-meta shape.
 */
function parseLegacyBeliefs(sectionBody: string): Array<{ text: string; meta: string }> {
  const items: Array<{ text: string; meta: string }> = [];
  const lines = sectionBody.split("\n");
  let currentText: string | null = null;
  let currentMeta = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("<!--")) continue;
    if (trimmed.startsWith("#")) break;

    if (trimmed.startsWith("- ")) {
      if (currentText) items.push({ text: currentText, meta: currentMeta });
      currentText = trimmed.slice(2).trim();
      currentMeta = "";
      continue;
    }

    if (currentText && trimmed && !trimmed.startsWith("#")) {
      currentMeta = currentMeta ? `${currentMeta} | ${trimmed}` : trimmed;
      continue;
    }
  }
  if (currentText) items.push({ text: currentText, meta: currentMeta });

  return items;
}

/** Extract the text between a start header and the next section header (or EOF). */
function extractSection(content: string, startHeader: string, endHeader: string | null): string | null {
  const startIdx = content.indexOf(startHeader);
  if (startIdx === -1) return null;
  const afterStart = content.slice(startIdx + startHeader.length);
  if (endHeader === null) return afterStart;
  const endIdx = afterStart.indexOf(endHeader);
  return endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);
}

/** Convert legacy { text, meta } items into v3 beliefs. */
function legacyItemsToBeliefs(items: Array<{ text: string; meta: string }>): PreviouslyBelief[] {
  return items.map((item) => {
    const belief: PreviouslyBelief = {
      text: item.text,
      refs: [],
      updated: formatDate(),
    };
    if (item.meta) parseMetaInto(item.meta, belief);
    return belief;
  });
}

/**
 * Migrate a legacy (v1 3-section / v2 long-short-term) previously.md body to v3.
 * Mapping (heuristic — the model refines content on later evolutions):
 *   identity   → profile.identity
 *   patterns   → profile.work_style
 *   strategies → selfModel.tool_discipline
 *   context    → profile.current_state (keeps its expires)
 * Already-v3 content is returned unchanged.
 */
export function migrateToV3(content: string, currentSliceId?: string): string {
  if (isV3Format(content)) return content;

  const sliceId =
    currentSliceId ??
    (content.match(/_Active slice: ([^\s|]+)/)?.[1]?.trim() ?? "unknown");

  const doc: PreviouslyDocument = {
    sliceId,
    updated: new Date().toISOString(),
    profile: {},
    selfModel: {},
  };

  // v2: 长期记忆 (identity/patterns/strategies) + 短期记忆 (context)
  if (isV2Format(content)) {
    const lt = extractSection(content, LEGACY_LONG_TERM, LEGACY_SHORT_TERM);
    if (lt) {
      const identitySection = extractSection(lt, "### User identity", "### ");
      if (identitySection) {
        doc.profile.identity = legacyItemsToBeliefs(parseLegacyBeliefs(identitySection));
      }
      const patternsSection = extractSection(lt, "### User patterns", "### ");
      if (patternsSection) {
        doc.profile.work_style = legacyItemsToBeliefs(parseLegacyBeliefs(patternsSection));
      }
      const strategiesSection = extractSection(lt, "### Agent strategies", "### ");
      if (strategiesSection) {
        doc.selfModel.tool_discipline = legacyItemsToBeliefs(parseLegacyBeliefs(strategiesSection));
      }
    }
    const st = extractSection(content, LEGACY_SHORT_TERM, null);
    if (st) {
      const contextSection = extractSection(st, "### Current context", "### ");
      if (contextSection) {
        doc.profile.current_state = legacyItemsToBeliefs(parseLegacyBeliefs(contextSection));
      }
    }
  } else {
    // v1: flat 3-section format.
    const identitySection = extractSection(content, LEGACY_IDENTITY, "## ");
    if (identitySection) {
      doc.profile.identity = legacyItemsToBeliefs(parseLegacyBeliefs(identitySection));
    }
    const patternsSection = extractSection(content, LEGACY_PATTERNS, "## ");
    if (patternsSection) {
      doc.profile.work_style = legacyItemsToBeliefs(parseLegacyBeliefs(patternsSection));
    }
    const strategiesSection = extractSection(content, LEGACY_STRATEGIES, "## ");
    if (strategiesSection) {
      doc.selfModel.tool_discipline = legacyItemsToBeliefs(parseLegacyBeliefs(strategiesSection));
    }
  }

  return serializePreviously(doc);
}
