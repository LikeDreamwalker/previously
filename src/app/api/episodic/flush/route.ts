/**
 * Emergency save endpoint for beforeunload — called via navigator.sendBeacon.
 *
 * Appends pending turns to the active time slice markdown file, persisting
 * in-flight conversation state before the page is torn down.
 *
 * This is fire-and-forget from the client's perspective: the browser does not
 * wait for the response. Errors are logged but not surfaced to the user.
 */
import { readFile, writeFile } from "@/lib/tools";
import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";
import { sliceIdToFilePath } from "@/lib/episodic/manager";
import { z } from "zod";
import { getRepoConfig, isDemo } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";

// ─── Types ───────────────────────────────────────────────────────────────

const flushRequestSchema = z.object({
  sliceId: z.string().min(1).max(64),
  turns: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        content: z.string().max(100_000),
        timestamp: z.string().max(64),
      })
    )
    .min(1),
});

type FlushRequest = z.infer<typeof flushRequestSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Count existing `## Turn N — …` headers in a markdown body so we know
 * where to resume numbering.
 */
function countExistingTurns(body: string): number {
  const matches = body.match(/^## Turn \d+ —/gm);
  return matches ? matches.length : 0;
}

/**
 * Format a single turn into its markdown block.
 */
function formatTurnBlock(
  turn: FlushRequest["turns"][number],
  index: number
): string {
  return `## Turn ${index} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`;
}

/**
 * Build a minimal frontmatter block for a brand-new slice file so the
 * resulting markdown is valid and parseable by the episodic manager.
 */
function buildFreshFrontmatter(sliceId: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `slice_id: "${sliceId}"`,
    'focus: ""',
    "status: active",
    `start: "${now}"`,
    "timezone: UTC",
    'summary: ""',
    "open_loops: []",
    "decisions: []",
    "tags: []",
    "related_slices: []",
    "---",
  ].join("\n");
}

// ─── Route handler ───────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    // Demo mode: flush writes are not persisted — the beforeunload save is
    // irrelevant without a writable backend. Return success so the client
    // doesn't retry or error.
    if (isDemo()) {
      return Response.json({ success: true, demo: true });
    }

    const parsed = flushRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    const { sliceId, turns } = parsed.data;

    // Compute the slice file path (matching getSlicePath in the episodic manager)
    const slicePath = sliceIdToFilePath(sliceId);

    // ── Read the existing slice body (if any) ──────────────────────────
    let existingContent = "";
    try {
      if (resolveDataSource() === "github") {
        const { owner, repo } = getRepoConfig();
        existingContent = await readFile(slicePath, repo, owner);
      } else {
        existingContent = await readFileLocal(slicePath);
      }
    } catch {
      // File doesn't exist yet — we will create it from scratch below.
    }

    // ── Build the new turn blocks ──────────────────────────────────────
    const startingIndex = countExistingTurns(existingContent);
    const newTurnBlocks = turns
      .map((turn, i) => formatTurnBlock(turn, startingIndex + i + 1))
      .join("\n\n");

    // ── Assemble the full document ─────────────────────────────────────
    let newContent: string;
    if (existingContent.trim()) {
      // Append to existing file
      newContent = existingContent.trimEnd() + "\n\n" + newTurnBlocks;
    } else {
      // Create a fresh file with minimal frontmatter
      newContent = buildFreshFrontmatter(sliceId) + "\n\n" + newTurnBlocks;
    }

    // ── Persist ────────────────────────────────────────────────────────
    if (resolveDataSource() === "github") {
      const { owner, repo } = getRepoConfig();
      await writeFile(slicePath, newContent, repo, owner, `Flush turns for slice ${sliceId}`);
    } else {
      await writeFileLocal(slicePath, newContent);
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("[episodic/flush] Persist failed:", error);
    return Response.json(
      { error: "Internal error" },
      { status: 500 }
    );
  }
}
