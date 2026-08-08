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

/**
 * Strip HTML comments from a belief text. The Previously Agent has been
 * observed writing `<!-- ⚠️ ... -->` INSIDE a belief's text instead of using
 * the structured `refuted_by` / `superseded_by` mechanism. Inline comments are
 * also parse-hostile: a comment on the same line as a belief bullet ends up in
 * the belief text and corrupts its meta line on re-parse. This is the defensive
 * backstop — serialization never emits them.
 */
export function stripInlineComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Serialize a single belief to its markdown representation. */
export function serializeBelief(b: PreviouslyBelief): string {
  const lines: string[] = [];
  lines.push(`- ${stripInlineComments(b.text)}`);

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
        text: stripInlineComments(trimmed.slice(2).trim()),
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
  if (isCardFormat(content)) return content; // v4 card — never downgrade to v3
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

// ─── User card format (v4) ──────────────────────────────────────────────────

/**
 * v4 "user card" — the compact successor to the v3 dimension archive.
 *
 * Structured identity head (machine-parsed) + ONE rolling profile paragraph
 * (hard-capped, updated IN PLACE by the evolution agent) + a short 7-day
 * recent-items list + a compact self-model list. The card is the stable,
 * byte-identical-within-a-slice snapshot that keeps the main agent's prompt
 * prefix cacheable; slices remain the lossless source of truth and every entry
 * keeps its `refs` so the agent can drill down with readSlice.
 */
export const CARD_STAMP = "Format: user card";
/** Recent-items older than this many days are dropped mechanically. */
export const CARD_RECENT_EXPIRY_DAYS = 7;
/** Hard caps — enforced by the card updater after every rewrite. */
export const CARD_RECENT_MAX = 5;
export const CARD_SELF_MODEL_MAX = 10;
/** Hard ceiling for the Profile paragraph (~600 tokens worst case). */
export const CARD_PROFILE_MAX_CHARS = 2400;

export interface CardRecentItem {
  text: string;
  refs: string[];
  /** ISO date the item was recorded — used for the 7-day expiry. */
  since: string;
}

export interface CardDocument {
  sliceId: string;
  updated: string;
  /** Structured identity head lines (Name: … / Address them as: … / Pronouns: …). */
  identity: string[];
  /** The rolling third-person profile paragraph. */
  profile: string;
  recent: CardRecentItem[];
  selfModel: string[];
}

/** Detect the v4 user-card format — the stamp is authoritative (sections can be empty). */
export function isCardFormat(content: string): boolean {
  return (
    content.includes(CARD_STAMP) ||
    (content.includes("## Profile") && content.includes("## Identity"))
  );
}

/** Create an empty user-card template. */
export function newCardTemplate(sliceId: string): string {
  return serializeCard({
    sliceId,
    updated: new Date().toISOString(),
    identity: [],
    profile: "",
    recent: [],
    selfModel: [],
  });
}

/** Serialize a CardDocument to markdown. Empty sections are omitted. */
export function serializeCard(doc: CardDocument): string {
  const lines: string[] = ["# Previously On", ""];
  lines.push(
    `_Active slice: ${doc.sliceId} | ${CARD_STAMP} | Updated: ${doc.updated}_`,
    "",
  );

  if (doc.identity.length > 0) {
    lines.push("## Identity", "");
    for (const line of doc.identity) lines.push(`- ${stripInlineComments(line)}`, "");
  }
  if (doc.profile.trim()) {
    lines.push("## Profile", "", doc.profile.trim(), "");
  }
  if (doc.recent.length > 0) {
    lines.push("## Recent", "");
    for (const r of doc.recent) {
      const refs = r.refs.length > 0 ? ` — refs: ${r.refs.map((x) => `[${x}]`).join(", ")}` : "";
      lines.push(`- ${stripInlineComments(r.text)}${refs} | since: ${r.since}`, "");
    }
  }
  if (doc.selfModel.length > 0) {
    lines.push("## Self-model", "");
    for (const s of doc.selfModel) lines.push(`- ${stripInlineComments(s)}`, "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Parse a serialized v4 user card into a CardDocument. Null for non-card content. */
export function parseCard(content: string): CardDocument | null {
  if (!isCardFormat(content)) return null;
  const headerMatch = content.match(/_Active slice: ([^\s|]+).*?Updated: (.+?)_/);
  const doc: CardDocument = {
    sliceId: headerMatch?.[1]?.trim() ?? "",
    updated: headerMatch?.[2]?.trim() ?? new Date().toISOString(),
    identity: [],
    profile: "",
    recent: [],
    selfModel: [],
  };

  let section: "identity" | "profile" | "recent" | "self_model" | null = null;
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "## Identity") { section = "identity"; continue; }
    if (trimmed === "## Profile") { section = "profile"; continue; }
    if (trimmed === "## Recent") { section = "recent"; continue; }
    if (trimmed === "## Self-model") { section = "self_model"; continue; }
    if (trimmed.startsWith("## ")) { section = null; continue; }
    if (!section) continue;

    if (section === "profile") {
      // Paragraph line — skip blank/header/stamp lines, keep flowing text.
      if (trimmed && !trimmed.startsWith("_") && !trimmed.startsWith("#") && !trimmed.startsWith("<!--")) {
        doc.profile = doc.profile ? `${doc.profile}\n${trimmed}` : trimmed;
      }
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const body = stripInlineComments(trimmed.slice(2).trim());
      if (!body) continue;
      if (section === "identity") doc.identity.push(body);
      else if (section === "self_model") doc.selfModel.push(body);
      else if (section === "recent") {
        const item: CardRecentItem = { text: body, refs: [], since: formatDate() };
        const sinceMatch = body.match(/\|\s*since:\s*(\d{4}-\d{2}-\d{2})/);
        if (sinceMatch) { item.since = sinceMatch[1]; item.text = item.text.replace(/\|\s*since:\s*\d{4}-\d{2}-\d{2}/, "").trim(); }
        const refsMatch = body.match(/—\s*refs:\s*(.*)$/);
        if (refsMatch) { item.refs = parseRefList(refsMatch[1]); item.text = item.text.replace(/—\s*refs:.*$/, "").trim(); }
        doc.recent.push(item);
      }
    }
  }

  return doc;
}

/**
 * Best-effort fold of a v3 (or legacy) document into the card format. Identity
 * → head; personality/communication/cognition/knowledge/values/work_style/goals
 * → one Profile paragraph; current_state/boundaries → Recent; all self-model
 * dimensions → the Self-model list. The evolution agent refines on later passes.
 */
export function migrateV3ToCard(content: string, currentSliceId?: string): string {
  if (isCardFormat(content)) return content;
  const v3 = migrateToV3(content, currentSliceId);
  const doc = parsePreviously(v3);
  const card: CardDocument = {
    sliceId: doc?.sliceId || currentSliceId || "unknown",
    updated: new Date().toISOString(),
    identity: [],
    profile: "",
    recent: [],
    selfModel: [],
  };
  if (doc) {
    for (const b of doc.profile.identity ?? []) card.identity.push(b.text);
    const sentences: string[] = [];
    for (const dim of ["personality", "communication", "cognition", "knowledge", "values", "work_style", "goals"] as const) {
      for (const b of doc.profile[dim] ?? []) sentences.push(b.text);
    }
    card.profile = sentences.join(" ");
    for (const b of doc.profile.current_state ?? []) card.recent.push({ text: b.text, refs: b.refs, since: b.updated });
    for (const b of doc.profile.boundaries ?? []) card.recent.push({ text: b.text, refs: b.refs, since: b.updated });
    for (const dim of SELF_MODEL_DIMENSIONS) {
      for (const b of doc.selfModel[dim] ?? []) card.selfModel.push(b.text);
    }
  }
  return serializeCard(card);
}
