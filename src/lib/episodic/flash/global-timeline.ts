/**
 * Global Timeline Index — a single file with summaries of all closed slices.
 *
 * Replaces the old `readRecentSummaries` which scanned monthly _index.json
 * files. The global timeline is one flat markdown file at
 * memory/episodic/timeline.md that the recall agent reads as its starting
 * point. Updated on slice close.
 */

import { fsReadFile, fsWriteFile } from "../io-helpers";
import { readSliceIndex } from "@/lib/episodic/manager";

const GLOBAL_TIMELINE_PATH = "memory/episodic/timeline.md";

// ─── Types ──────────────────────────────────────────────────────────────

export interface TimelineEntry {
  slice_id: string;
  focus: string;
  summary: string;
  tags: string[];
  status: string;
  start: string;
}

// ─── Format helpers ────────────────────────────────────────────────────

export function formatEntry(entry: TimelineEntry): string {
  const tags = entry.tags.length > 0 ? entry.tags.join(", ") : "untagged";
  const status = entry.status === "active" ? "🟡" : "⚫";
  return [
    `## ${entry.slice_id}`,
    `- Focus: ${entry.focus || "(none)"}`,
    `- Summary: ${entry.summary || "(none)"}`,
    `- Tags: ${tags}`,
    `- Status: ${status} ${entry.status}`,
    `- Start: ${entry.start}`,
    "",
  ].join("\n");
}

export function buildTimelineContent(entries: TimelineEntry[]): string {
  const header = [
    "# Global Timeline Index",
    "",
    `_Generated: ${new Date().toISOString()}_`,
    `_Total slices: ${entries.length}_`,
    "",
    "---",
    "",
  ].join("\n");

  const body = entries.map(formatEntry).join("");
  return header + body;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Rebuild the entire global timeline from monthly indices.
 * Called on-demand or during maintenance. Scans up to 24 months back.
 */
export async function generateGlobalTimeline(): Promise<string> {
  const now = new Date();
  const allEntries: TimelineEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < 24; i++) {
    let m = now.getUTCMonth() + 1 - i;
    let y = now.getUTCFullYear();
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    try {
      const index = await readSliceIndex(y, m);
      for (const entry of index) {
        // Only closed slices belong in the memory index. The active slice is
        // the ONGOING conversation — recall must never see it as a past memory
        // (it would self-match the very query being asked).
        if (entry.status === "active") continue;
        const sliceId = entry.id?.includes("-")
          ? entry.id
          : `${entry.start.slice(0, 7)}/${entry.id}`;
        if (seen.has(sliceId)) continue;
        seen.add(sliceId);
        allEntries.push({
          slice_id: sliceId,
          focus: entry.focus,
          summary: entry.summary,
          tags: entry.tags ?? [],
          status: entry.status,
          start: entry.start,
        });
      }
    } catch {
      // Month index doesn't exist — skip
    }
  }

  // Sort newest first
  allEntries.sort((a, b) => b.start.localeCompare(a.start));

  const content = buildTimelineContent(allEntries);
  await fsWriteFile(GLOBAL_TIMELINE_PATH, content);
  return content;
}

/**
 * Update the global timeline when a slice is closed.
 * Appends the new entry at the top (newest first) and updates the count.
 */
export async function updateGlobalTimeline(entry: TimelineEntry): Promise<void> {
  let existing = "";
  try {
    existing = await fsReadFile(GLOBAL_TIMELINE_PATH);
  } catch {
    // No existing timeline — generate fresh
    await generateGlobalTimeline();
    return;
  }

  // Insert after the header separator (after the first "---")
  const separatorIndex = existing.indexOf("\n---\n");
  if (separatorIndex === -1) {
    // Malformed — rebuild
    await generateGlobalTimeline();
    return;
  }

  const newEntryText = formatEntry(entry);
  const before = existing.slice(0, separatorIndex + 5); // include "\n---\n"
  const after = existing.slice(separatorIndex + 5);

  // Update total count — parse current, increment, replace
  const currentCount = parseInt((existing.match(/_Total slices: (\d+)_/)?.[1]) ?? "0", 10);
  const updatedBefore = before.replace(
    /_Total slices: \d+_/,
    `_Total slices: ${currentCount + 1}_`,
  );

  const updated = updatedBefore + "\n" + newEntryText + after;
  await fsWriteFile(GLOBAL_TIMELINE_PATH, updated);
}
