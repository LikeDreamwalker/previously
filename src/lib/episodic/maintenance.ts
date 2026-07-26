/**
 * Episodic memory maintenance — pure functions for metadata and belief updates.
 *
 * Flash LLM calls live in dedicated modules:
 *   - src/lib/episodic/flash/recall.ts           (recall search mini-agent)
 *   - src/lib/episodic/flash/previously-agent.ts  (previously.md evolution)
 *
 * This module contains only pure data types and pure transformation
 * functions — no I/O, no LLM calls, no Node dependencies.
 *
 * NOTE: applyBeliefUpdates operates on the OLD v1 format (flat 3-section).
 * New code should use previously-updater.ts (v2 long/short-term format).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface SliceMetadata {
  slice_id: string;
  focus: string;
  summary: string;
  open_loops: string[];
  decisions: string[];
  tags: string[];
  emotional_tone: string;
}

export interface BeliefUpdate {
  action: "observe" | "reinforce" | "contradict" | "discard";
  section: "User identity" | "User patterns" | "Agent strategies";
  /** Full belief text (required for "observe"). */
  belief?: string;
  /**
   * Unique substring to match an existing belief (required for
   * "reinforce" / "contradict" / "discard"). Must appear in the
   * belief bullet line, not the annotation.
   */
  belief_key?: string;
  /** Slice path in YYYY/MM/DD/HHMM format. */
  evidence_slice: string;
  /** Turn ID within the evidence slice. */
  evidence_turn: string;
  /** Explanation of the contradiction (for "contradict"). */
  note?: string;
  /** Why the belief is being removed (for "discard"). */
  reason?: string;
}

// ─── Metadata update helpers ──────────────────────────────────────────

type NullableUpdates = {
  focus?: string | null;
  summary?: string | null;
  open_loops?: string[] | null;
  decisions?: string[] | null;
  tags?: string[] | null;
  emotional_tone?: string | null;
};

/**
 * Apply metadata updates from Flash to the slice object.
 * undefined = no change (omit the field).
 * null = clear the field (set to empty string/array).
 * Any other value = update.
 */
export function applyMetadataUpdates(
  slice: SliceMetadata,
  updates: NullableUpdates | null,
): void {
  if (!updates) return;

  // String fields: null clears, undefined skips
  if (updates.focus !== undefined) slice.focus = updates.focus ?? "";
  if (updates.summary !== undefined) slice.summary = updates.summary ?? "";
  if (updates.emotional_tone !== undefined) slice.emotional_tone = updates.emotional_tone ?? "";

  // Array fields: null clears, undefined skips
  if (updates.decisions !== undefined) slice.decisions = updates.decisions ?? [];
  if (updates.open_loops !== undefined) slice.open_loops = updates.open_loops ?? [];
  if (updates.tags !== undefined) slice.tags = updates.tags ?? [];
}

// ─── Belief update application ─────────────────────────────────────────

/**
 * Apply a list of Flash-emitted belief mutations to a previously.md body.
 *
 * Pure string-in/string-out — no I/O, deterministic, testable.
 * Only Flash emits mutations; this function just applies them.
 *
 * - `observe`: append a new belief to the target section
 * - `reinforce`: bump observation count, update 最近 date, promote 中→高 at ≥5 obs
 * - `contradict`: drop confidence one level, append note
 * - `discard`: remove the belief (bullet + annotation lines)
 */
export function applyBeliefUpdates(
  content: string,
  updates: BeliefUpdate[],
  currentSliceId: string,
): string {
  // ── Sanitize: strip lingering undefined- prefix from existing content ──
  // Old data written before the evidence_slice fix still carries the prefix.
  // Must run BEFORE the early return — stale data needs cleanup even when
  // there are zero new mutations.
  content = content.replace(
    /\bundefined-(\d{4}[-\/]\d{2}[-\/]\d{2}[-\/]\d{4}-[A-Za-z0-9_-]+)/g,
    "$1",
  );

  if (!updates.length) return content;

  // ── Sanitize: fix missing/malformed evidence_slice (Fix #4) ──────────
  // Flash sometimes omits the field, producing "undefined-YYYY-MM-DD-..." in
  // annotations. Fall back to currentSliceId so annotations are always valid.
  const currentSlicePath = currentSliceId.replace(/-/g, "/");
  for (const u of updates) {
    if (!u.evidence_slice || u.evidence_slice === "undefined") {
      u.evidence_slice = currentSlicePath;
    }
  }

  const lines = content.split("\n");
  const result: string[] = [];

  const sectionHeaders = [
    "## User identity",
    "## User patterns",
    "## Agent strategies",
  ];
  let currentSection: string | null = null;

  const observesBySection: Map<string, string[]> = new Map();

  // Pre-process: separate observe from other actions
  for (const u of updates) {
    if (u.action === "observe" && u.belief) {
      // Dedup (Fix #3): skip if the belief text already exists in the content.
      // Flash sometimes emits duplicate observations for the same belief.
      if (content.includes(`- ${u.belief}`)) continue;

      const existing = observesBySection.get(u.section) ?? [];
      const annotation =
        u.section === "User identity"
          ? `  (来源: ${u.evidence_slice}-${u.evidence_turn}，用户原话)`
          : u.section === "Agent strategies"
            ? `  (source: ${u.evidence_slice}-${u.evidence_turn})`
            : `  (置信度: 中 | 首次: ${u.evidence_slice}-${u.evidence_turn} | 最近: ${u.evidence_slice}-${u.evidence_turn} | 观察: 1)`;
      existing.push(`- ${u.belief}\n${annotation}`);
      observesBySection.set(u.section, existing);
    }
  }

  // Build a map of (section, belief_key) → action
  const mutationMap = new Map<string, BeliefUpdate>();
  for (const u of updates) {
    if (u.action !== "observe" && u.belief_key && u.section) {
      mutationMap.set(`${u.section}::${u.belief_key}`, u);
    }
  }

  // Sections that will receive mutations — used to strip stale placeholders.
  const mutatedSections: Set<string> = new Set(
    updates.map((u) => u.section).filter(Boolean),
  );

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Track section
    for (const h of sectionHeaders) {
      if (line.startsWith(h)) {
        currentSection = h.replace("## ", "");
        break;
      }
    }
    if (line.startsWith("## ") && !sectionHeaders.some((h) => line.startsWith(h))) {
      currentSection = null;
    }

    // Update the active slice header
    if (/^_Active slice:/.test(line)) {
      result.push(`_Active slice: ${currentSliceId} | Last updated: Turn ${updates[0]?.evidence_turn ?? "?"}_`);
      i++;
      continue;
    }

    // Strip `_No beliefs yet._` placeholder when the section is receiving mutations.
    if (line.trim() === "_No beliefs yet._" && currentSection && mutatedSections.has(currentSection)) {
      i++;
      // Also skip trailing blank line after the placeholder
      if (i < lines.length && lines[i].trim() === "") {
        i++;
      }
      continue;
    }

    // Check if this is a belief bullet line that matches a mutation
    if (line.trimStart().startsWith("- ") && currentSection) {
      let matchedUpdate: BeliefUpdate | null = null;
      for (const [key, u] of mutationMap) {
        const [section, beliefKey] = key.split("::");
        if (section === currentSection && line.includes(beliefKey)) {
          matchedUpdate = u;
          break;
        }
      }

      if (matchedUpdate) {
        const u = matchedUpdate;
        const nextLine = i + 1 < lines.length ? lines[i + 1] : "";

        if (u.action === "discard") {
          i++;
          if (i < lines.length && lines[i].trim().startsWith("(")) {
            i++;
          }
          if (i < lines.length && lines[i].trim() === "") {
            i++;
          }
          continue;
        }

        if (u.action === "reinforce" && nextLine.includes("置信度:")) {
          const annotation = nextLine;
          const now = `${u.evidence_slice}-${u.evidence_turn}`;

          let updatedAnnotation = annotation.replace(
            /观察: (\d+)/,
            (_m, n) => `观察: ${parseInt(n, 10) + 1}`,
          );

          updatedAnnotation = updatedAnnotation.replace(
            /最近: \S+/,
            `最近: ${now}`,
          );

          const newObs = parseInt(
            (updatedAnnotation.match(/观察: (\d+)/) ?? ["", "0"])[1],
            10,
          );
          if (newObs >= 5 && updatedAnnotation.includes("置信度: 中")) {
            updatedAnnotation = updatedAnnotation.replace(
              "置信度: 中",
              "置信度: 高",
            );
          }

          result.push(line);
          result.push(updatedAnnotation);
          i += 2;
          if (i < lines.length && lines[i].trim() === "") {
            result.push(lines[i]);
            i++;
          }
          continue;
        }

        if (u.action === "contradict" && nextLine.includes("置信度:")) {
          const annotation = nextLine;
          let updatedAnnotation = annotation;
          if (updatedAnnotation.includes("置信度: 高")) {
            updatedAnnotation = updatedAnnotation.replace("置信度: 高", "置信度: 中");
          } else if (updatedAnnotation.includes("置信度: 中")) {
            updatedAnnotation = updatedAnnotation.replace("置信度: 中", "置信度: 低");
          }

          result.push(line);
          result.push(updatedAnnotation);
          if (u.note) {
            result.push(`  <!-- 矛盾: ${u.note} (${u.evidence_slice}-${u.evidence_turn}) -->`);
          }
          i += 2;
          if (i < lines.length && lines[i].trim() === "") {
            result.push(lines[i]);
            i++;
          }
          continue;
        }
      }
    }

    result.push(line);
    i++;
  }

  // Append new observations at the end of each section
  let finalResult = result.join("\n");

  for (const [section, beliefs] of observesBySection) {
    const sectionIdx = findSectionEnd(result, section);

    if (sectionIdx >= 0 && beliefs.length > 0) {
      const before = result.slice(0, sectionIdx);
      const after = result.slice(sectionIdx);
      let insertAt = after.length;
      for (let j = 0; j < after.length; j++) {
        if (after[j].startsWith("## ")) {
          insertAt = j;
          break;
        }
      }
      const newResult = [...before, ...after.slice(0, insertAt)];
      for (const b of beliefs) {
        newResult.push(...b.split("\n"));
        newResult.push("");
      }
      newResult.push(...after.slice(insertAt));
      result.length = 0;
      result.push(...newResult);
      finalResult = result.join("\n");
    }
  }

  // ── Post-process: clear _No beliefs yet._ from sections with beliefs ──
  // Fix #5: previously we only stripped the placeholder when a section received
  // mutations this round. But a section can have beliefs from prior rounds with
  // no new mutations — the placeholder must still be cleared. Now we iterate all
  // three sections unconditionally: if a section has ≥1 belief, strip placeholder.
  finalResult = clearStalePlaceholders(finalResult);

  return finalResult;
}

/** Clear _No beliefs yet._ from any section that already has ≥1 belief bullet. */
function clearStalePlaceholders(content: string): string {
  const sectionHeaders = [
    "## User identity",
    "## User patterns",
    "## Agent strategies",
  ];

  const lines = content.split("\n");

  // First pass: identify which sections have at least one belief bullet.
  const sectionsWithBeliefs = new Set<string>();
  let scanSection: string | null = null;
  for (const line of lines) {
    for (const h of sectionHeaders) {
      if (line.startsWith(h)) {
        scanSection = h.replace("## ", "");
        break;
      }
    }
    if (
      line.startsWith("## ") &&
      !sectionHeaders.some((h) => line.startsWith(h))
    ) {
      scanSection = null;
    }
    if (scanSection && line.trimStart().startsWith("- ")) {
      sectionsWithBeliefs.add(scanSection);
    }
  }

  // Second pass: strip placeholder from sections that have beliefs.
  const result: string[] = [];
  let currentSection: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    for (const h of sectionHeaders) {
      if (line.startsWith(h)) {
        currentSection = h.replace("## ", "");
        break;
      }
    }
    if (
      line.startsWith("## ") &&
      !sectionHeaders.some((h) => line.startsWith(h))
    ) {
      currentSection = null;
    }

    if (
      line.trim() === "_No beliefs yet._" &&
      currentSection &&
      sectionsWithBeliefs.has(currentSection)
    ) {
      i++;
      if (i < lines.length && lines[i].trim() === "") {
        i++;
      }
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

/** Find the line index right after a section header's content ends. */
function findSectionEnd(lines: string[], sectionName: string): number {
  const header = `## ${sectionName}`;
  let foundHeader = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(header)) {
      foundHeader = true;
      continue;
    }
    if (foundHeader && lines[i].startsWith("## ")) {
      return i;
    }
  }
  return foundHeader ? lines.length : -1;
}
