/**
 * Dry-slice backfill — opportunistic semantic marking for slices that closed
 * without focus/summary (`needs_marking` in the timeline catalog).
 *
 * The weave TRACKS dry slices but nothing rewrote their semantics; this is the
 * remediation. It runs ONLY from the slice-close boundary in housekeeping
 * (never per-turn), takes at most BACKFILL_MAX_PER_TURN candidates, and marks
 * each slice from its core.md through the shared sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts, v0.9: turn's MAIN model, thinking on at
 * low effort, static system prompt) — mirroring the close-marking task in
 * ./turn-analyzer.ts. Marks are written into the slices' frontmatter and the
 * catalog entries refreshed, all inside the turn's existing write batch.
 *
 * Best-effort by contract: any failure skips the slice (or the whole run)
 * silently — a backfill must never take a turn down. The caller excludes the
 * active slice and skips demo mode (demo writes are no-ops).
 */
import { tool } from "ai";
import { z } from "zod";
import matter from "gray-matter";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
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

/** Static role block — system prompt shared across every marking call. */
const BACKFILL_SYSTEM = buildSubAgentSystem(`You are the slice-marking agent for a personal memory system.

A past conversation time slice was closed without a summary. The user message carries its conversation (first turn + last turns). Mark it so future recall can understand it at a glance.

Return via \`markOutput\`:
- focus: one sentence on what this session was about
- summary: at most 100 characters — what happened / key decisions`);

/** Ask the model for focus/summary of one dry slice. Null on any failure. */
async function markOneSlice(
  model: ModelConfig,
  coreRaw: string,
): Promise<{ focus: string; summary: string } | null> {
  const { turns } = parseTurns(coreRaw);
  if (turns.length === 0) return null;
  const result = await runSubAgent({
    model,
    system: BACKFILL_SYSTEM,
    prompt: `Conversation (first turn + last turns):\n${compressTurns(turns)}`,
    tools: {
      markOutput: tool({
        description: "Report the slice marking.",
        inputSchema: markSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "markOutput",
    reportSchema: markSchema,
    maxSteps: 50,
    timeoutMs: 30_000,
    progress: { toolName: "backfill-marks" },
  });

  // The runner never throws — best-effort contract: any failure skips the slice.
  if (!result.ok || !result.report) return null;
  const focus = result.report.focus.trim();
  const summary = result.report.summary.trim();
  return focus || summary ? { focus, summary } : null;
}

/**
 * Gather up to BACKFILL_MAX_PER_TURN needs-marking candidates with their
 * compressed conversations — the picking half of backfill, exported so the
 * housekeeping bridge call can fold the marking into its ONE report
 * (phase outsourcing) instead of spawning a sub-agent per slice.
 * Never throws; never touches `excludeSliceIds`.
 */
export async function collectDrySliceCandidates(opts: {
  excludeSliceIds: string[];
  batch: WriteBatch;
}): Promise<Array<{ sliceId: string; conversation: string }>> {
  try {
    const idx = await readTimelineIndex(opts.batch);
    if (!idx) return [];
    const exclude = new Set(opts.excludeSliceIds);
    const candidates = idx.slices
      .filter((s) => s.needs_marking && !exclude.has(s.id))
      .slice(0, BACKFILL_MAX_PER_TURN);
    const out: Array<{ sliceId: string; conversation: string }> = [];
    for (const entry of candidates) {
      try {
        const corePath = sliceCorePath(entry.id.split("-").join("/"));
        const raw = await fsReadFile(corePath, opts.batch);
        const { turns } = parseTurns(raw);
        if (turns.length === 0) continue;
        out.push({ sliceId: entry.id, conversation: compressTurns(turns) });
      } catch {
        // best-effort — skip this slice silently
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Write focus/summary marks into dry slices' frontmatter and refresh the
 * timeline catalog — the write half of backfill, shared by the sub-agent
 * path (below) and the housekeeping bridge report (phase outsourcing).
 * Returns how many were marked. Never throws.
 */
export async function applyMarksToDrySlices(
  marks: Array<{ id: string; focus: string; summary: string }>,
  batch: WriteBatch,
): Promise<number> {
  try {
    if (marks.length === 0) return 0;
    const idx = await readTimelineIndex(batch);
    if (!idx) return 0;

    let marked = 0;
    for (const mark of marks.slice(0, BACKFILL_MAX_PER_TURN)) {
      try {
        const entry = idx.slices.find((s) => s.id === mark.id);
        if (!entry || !entry.needs_marking) continue;
        const corePath = sliceCorePath(mark.id.split("-").join("/"));
        const raw = await fsReadFile(corePath, batch);

        // Write the marks into the slice's frontmatter (body untouched).
        const parsed = matter(raw);
        const fm: Record<string, unknown> = { ...parsed.data };
        if (mark.focus) fm.focus = mark.focus;
        if (mark.summary) fm.summary = mark.summary;
        await fsWriteFile(
          corePath,
          matter.stringify(parsed.content, fm),
          batch,
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
      await writeTimelineIndex(idx, batch);
      await writeTimelineMd(renderTimelineMd(idx), batch);
    }
    return marked;
  } catch {
    return 0;
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
    const candidates = await collectDrySliceCandidates({
      excludeSliceIds: opts.excludeSliceIds,
      batch: opts.batch,
    });
    if (candidates.length === 0) return 0;

    const marks: Array<{ id: string; focus: string; summary: string }> = [];
    for (const candidate of candidates) {
      // Per-candidate isolation: one unreadable core.md (or a marking
      // failure) skips THAT slice — the rest still get marked.
      try {
        const corePath = sliceCorePath(candidate.sliceId.split("-").join("/"));
        const raw = await fsReadFile(corePath, opts.batch);
        const mark = await markOneSlice(opts.model, raw);
        if (!mark) continue;
        marks.push({ id: candidate.sliceId, ...mark });
      } catch {
        // skip this candidate
      }
    }
    return await applyMarksToDrySlices(marks, opts.batch);
  } catch {
    return 0;
  }
}
