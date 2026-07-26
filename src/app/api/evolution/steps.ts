/**
 * Evolution workflow step functions — full Node.js, retried automatically.
 *
 * Kept separate from the workflow body so Node-dependent imports
 * (episodic manager, LLM calls) never enter the deterministic workflow bundle.
 *
 * Steps:
 *   1. readEvolutionContext — find current slice, read previously.md + agent.md
 *   2. finalizeEvolution   — run Previously Agent, apply mutations, write, close stream
 */

import { type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import { runPreviouslyAgent } from "@/lib/episodic/flash/previously-agent";
import { applyPreviouslyAgentOutput } from "@/lib/episodic/previously-updater";
import {
  tryLoadTodaySlice,
  readPreviously,
  writePreviously,
  readAgentTimeline,
  sliceIdToFilePath,
} from "@/lib/episodic";
import { readFile } from "@/lib/tools/readFile";
import { readFileLocal } from "@/lib/tools/local-fs";
import { readFileDemo } from "@/lib/demo/demo-fs";
import { parseSliceId, parseTurns, type ParsedTurn } from "@/lib/episodic/turn-parser";

// ─── Shared types ──────────────────────────────────────────────────────────

export interface EvolutionContext {
  sliceId: string;
  previouslyContent: string;
  agentCognition: string;
  recentTurns: Array<{ role: string; content: string }>;
}

// ─── Step 1: Read evolution context ────────────────────────────────────────

export async function readEvolutionContext(input: {
  repo: string;
  owner: string;
  useGithub: boolean;
  useDemo: boolean;
}): Promise<EvolutionContext> {
  "use step";

  const writer = getWritable<UIMessageChunk>().getWriter();
  await writer.write({ type: "start" } as UIMessageChunk);
  await writer.write({ type: "start-step" } as UIMessageChunk);
  await writer.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution-progress",
    data: { running: true, step: "reading" },
  } as UIMessageChunk);
  writer.releaseLock();

  // Find the current slice — scan today's directory
  let sliceId = "unknown";
  let previouslyContent = "";
  let agentCognition = "";
  let recentTurns: Array<{ role: string; content: string }> = [];

  try {
    const slice = await tryLoadTodaySlice();
    if (slice) {
      sliceId = slice.slice_id;
      // Read previously.md and agent.md for this slice
      try { previouslyContent = await readPreviously(sliceId); } catch { /* empty */ }
      try { agentCognition = await readAgentTimeline(sliceId); } catch { /* empty */ }

      // Extract recent turns from core.md
      try {
        const corePath = sliceIdToFilePath(sliceId);
        let raw: string;
        if (input.useDemo) raw = await readFileDemo(corePath);
        else if (input.useGithub) raw = await readFile(corePath, input.repo, input.owner);
        else raw = await readFileLocal(corePath);

        const { turns } = parseTurns(raw);
        recentTurns = turns.slice(-6).map((t) => ({
          role: t.header.includes("(user)") ? "user" : "agent",
          content: t.content.slice(0, 600),
        }));
      } catch { /* no core.md yet */ }
    } else {
      // No active slice — try most recent previously.md from any slice
      try {
        const { findMostRecentPreviously } = await import("@/lib/episodic");
        const recent = await findMostRecentPreviously();
        if (recent) previouslyContent = recent;
      } catch { /* nothing available */ }
    }
  } catch { /* slice discovery failed, use empty context */ }

  console.log(`[Evolution] Context loaded for slice ${sliceId}: previously=${previouslyContent.length} chars, cognition=${agentCognition.length} chars, turns=${recentTurns.length}`);

  return { sliceId, previouslyContent, agentCognition, recentTurns };
}

// ─── Step 2: Run Previously Agent, apply mutations, close stream ───────────

export async function finalizeEvolution(
  input: {
    repo: string;
    owner: string;
    useGithub: boolean;
    useDemo: boolean;
  },
  context: EvolutionContext,
): Promise<void> {
  "use step";

  const { sliceId, previouslyContent, agentCognition, recentTurns } = context;

  // Emit reviewing phase
  const writer0 = getWritable<UIMessageChunk>().getWriter();
  await writer0.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution-progress",
    data: { running: true, step: "reviewing" },
  } as UIMessageChunk);
  writer0.releaseLock();

  // Run Previously Agent — always signal new_observation for auto-review
  let changes = { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 };
  let mutations: Awaited<ReturnType<typeof runPreviouslyAgent>>["mutations"] = [];
  let error: string | undefined;

  try {
    const result = await runPreviouslyAgent({
      signal: "new_observation",
      note: "Auto-review of latest conversation.",
      currentSliceId: sliceId,
      previouslyContent,
      agentCognition,
      recentTurns,
      readSliceFn: async (sid: string, range?) => {
        const parsed = parseSliceId(sid);
        if (!parsed) return `ERROR: Invalid slice ID.`;
        const path = `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`;
        try {
          let raw: string;
          if (input.useDemo) raw = await readFileDemo(path);
          else if (input.useGithub) raw = await readFile(path, input.repo, input.owner);
          else raw = await readFileLocal(path);
          if (range) {
            const { frontmatter, turns } = parseTurns(raw);
            if (range.type === "last") {
              const n = range.count ?? 3;
              const filtered = turns.slice(-n);
              return frontmatter + "\n" + filtered.map((t) => `${t.header}\n${t.content}`).join("\n");
            }
            // For other range types, return full content (simplified)
            return raw;
          }
          return raw;
        } catch { return `(slice not found: ${sid})`; }
      },
      readAgentTimelineFn: async (sid: string) => {
        try { return await readAgentTimeline(sid); } catch { return `(not found: ${sid})`; }
      },
      readPreviouslyFn: async (sid: string) => {
        try { return await readPreviously(sid); } catch { return `(not found: ${sid})`; }
      },
    });

    mutations = result.mutations;

    if (result.reasoning) {
      console.log(`[Evolution] reasoning: ${result.reasoning}`);
    }

    if (result.mutations.length > 0) {
      const applied = applyPreviouslyAgentOutput(previouslyContent, result.mutations, sliceId);
      await writePreviously(sliceId, applied.content);
      changes = applied.changes;

      console.log(
        `[Evolution] ${applied.changes.added} added, ` +
        `${applied.changes.reinforced} reinforced, ${applied.changes.demoted} demoted, ` +
        `${applied.changes.removed} removed.`,
      );
    }
  } catch (err) {
    console.warn("[Evolution] Previously Agent failed:", err instanceof Error ? err.message : err);
    error = err instanceof Error ? err.message : "Previously Agent unavailable";
  }

  // Emit completion chunk
  const writer1 = getWritable<UIMessageChunk>().getWriter();
  await writer1.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution-result",
    data: {
      running: false,
      changes,
      mutations,
      hasChanges: mutations.length > 0,
      error,
    },
  } as UIMessageChunk);
  await writer1.write({ type: "finish-step" } as UIMessageChunk);
  await writer1.write({ type: "finish" } as UIMessageChunk);
  writer1.releaseLock();

  const writable = getWritable<UIMessageChunk>();
  await writable.close();
}
