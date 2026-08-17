/**
 * Dry-slice backfill — opportunistic semantic marking for slices that closed
 * without focus/summary (`needs_marking` in the timeline catalog).
 *
 * The weave TRACKS dry slices but nothing rewrote their semantics; this is the
 * remediation. It runs ONLY from the slice-close boundary in housekeeping
 * (never per-turn), takes at most BACKFILL_MAX_PER_TURN candidates, and lets
 * the worker model produce focus/summary from each slice's core.md — mirroring
 * the close-marking prompt in ./turn-analyzer.ts. Marks are written into the
 * slices' frontmatter and the catalog entries refreshed, all inside the turn's
 * existing write batch.
 *
 * Best-effort by contract: any failure skips the slice (or the whole run)
 * silently — a backfill must never take a turn down. The caller excludes the
 * active slice and skips demo mode (demo writes are no-ops).
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import matter from "gray-matter";
import { createModel } from "@/lib/models/provider";
import { workerProviderOptions } from "@/lib/models/worker";
import type { ModelConfig } from "@/lib/models/registry";
import { fsReadFile, fsWriteFile, type WriteBatch } from "../io-helpers";
import { parseTurns, type ParsedTurn } from "../turn-parser";
import {
  readTimelineIndex,
  sliceCorePath,
  writeTimelineIndex,
  writeTimelineMd,
} from "../timeline/store";
import { renderTimelineMd } from "../timeline/render";

/** Bounded: at most this many dry slices are re-marked per close boundary. */
export const BACKFILL_MAX_PER_TURN = 3;

const markSchema = z.object({
  focus: z.string().describe("One sentence: what this session was about."),
  summary: z
    .string()
    .describe("At most 100 characters: what happened / key decisions."),
});

/** Compress a slice's turns for the marking prompt — first turn + last 10,
 *  chars capped (mirrors turn-analyzer's compressSliceTurns). */
function compressTurns(turns: ParsedTurn[]): string {
  if (turns.length === 0) return "(empty slice)";
  const pick = turns.length <= 11 ? turns : [turns[0], ...turns.slice(-10)];
  const body = pick
    .map((t) => {
      const role = t.header.match(/\((\w+)\)\s*$/)?.[1] ?? "?";
      return `${role}: ${t.content.slice(0, 300)}`;
    })
    .join("\n");
  return body.length > 6000 ? body.slice(-6000) : body;
}

/** Ask the worker model for focus/summary of one dry slice. Null on any failure. */
async function markOneSlice(
  model: ModelConfig,
  coreRaw: string,
): Promise<{ focus: string; summary: string } | null> {
  const { turns } = parseTurns(coreRaw);
  if (turns.length === 0) return null;
  try {
    const result = await generateText({
      model: createModel(model),
      temperature: 0.1,
      tools: {
        markOutput: tool({
          description: "Report the slice marking.",
          inputSchema: markSchema,
        }),
      },
      toolChoice: "required",
      providerOptions: workerProviderOptions(model.sdk),
      prompt: `A past conversation time slice was closed without a summary. Mark it so future recall can understand it at a glance.

Conversation (first turn + last turns):
${compressTurns(turns)}

Return:
- focus: one sentence on what this session was about
- summary: at most 100 characters — what happened / key decisions`,
    });
    const tc = result.toolCalls?.[0];
    if (tc?.toolName !== "markOutput" || !tc.input) return null;
    const parsed = markSchema.safeParse(tc.input);
    if (!parsed.success) return null;
    const focus = parsed.data.focus.trim();
    const summary = parsed.data.summary.trim();
    return focus || summary ? { focus, summary } : null;
  } catch {
    return null;
  }
}

/**
 * Re-mark up to BACKFILL_MAX_PER_TURN needs-marking slices. Returns how many
 * were marked. Never throws; never touches `excludeSliceIds` (the caller lists
 * the active + just-closed slices there).
 */
export async function backfillDrySliceMarks(opts: {
  model: ModelConfig;
  excludeSliceIds: string[];
  batch: WriteBatch;
}): Promise<number> {
  try {
    const idx = await readTimelineIndex(opts.batch);
    if (!idx) return 0;
    const exclude = new Set(opts.excludeSliceIds);
    const candidates = idx.slices
      .filter((s) => s.needs_marking && !exclude.has(s.id))
      .slice(0, BACKFILL_MAX_PER_TURN);
    if (candidates.length === 0) return 0;

    let marked = 0;
    for (const entry of candidates) {
      try {
        const corePath = sliceCorePath(entry.id.split("-").join("/"));
        const raw = await fsReadFile(corePath, opts.batch);
        const mark = await markOneSlice(opts.model, raw);
        if (!mark) continue;

        // Write the marks into the slice's frontmatter (body untouched).
        const parsed = matter(raw);
        const fm: Record<string, unknown> = { ...parsed.data };
        if (mark.focus) fm.focus = mark.focus;
        if (mark.summary) fm.summary = mark.summary;
        await fsWriteFile(
          corePath,
          matter.stringify(parsed.content, fm),
          opts.batch,
        );

        // Refresh the catalog entry to match.
        if (mark.focus) entry.focus = mark.focus;
        if (mark.summary) entry.summary = mark.summary;
        entry.needs_marking = !entry.focus && !entry.summary;
        marked += 1;
      } catch {
        // best-effort — skip this slice silently
      }
    }

    if (marked > 0) {
      idx.needs_marking = idx.slices.filter((s) => s.needs_marking).length;
      idx.updated_at = new Date().toISOString();
      await writeTimelineIndex(idx, opts.batch);
      await writeTimelineMd(renderTimelineMd(idx), opts.batch);
    }
    return marked;
  } catch {
    return 0;
  }
}
