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
import { applyCardUpdate } from "@/lib/episodic/previously-updater";
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
import matter from "gray-matter";
import type { PreviouslySignal } from "@/lib/episodic/flash/previously-agent";

const VALID_SIGNALS: PreviouslySignal[] = [
  "new_observation",
  "user_correction",
  "slice_closed",
  "self_reflection",
];

// ─── Shared types ──────────────────────────────────────────────────────────

export interface EvolutionContext {
  sliceId: string;
  previouslyContent: string;
  agentCognition: string;
  /** Last 3 turns (incremental): last user, last agent, current user. Full content. */
  recentTurns: Array<{ role: string; content: string }>;
  /** Tags on the current slice. */
  currentSliceTags: string[];
}

// ─── Step 1: Read evolution context ────────────────────────────────────────

export async function readEvolutionContext(input: {
  repo: string;
  owner: string;
  useGithub: boolean;
  useDemo: boolean;
  /** Target slice to evolve — a just-closed slice (v0.7), else the active one. */
  sliceId?: string;
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

  // Find the target slice — an explicit sliceId (a just-closed slice) wins;
  // otherwise scan today's directory for the active slice.
  let sliceId = "unknown";
  let previouslyContent = "";
  let agentCognition = "";
  let recentTurns: Array<{ role: string; content: string }> = [];
  let currentSliceTags: string[] = [];

  try {
    let targetId = input.sliceId?.trim() ?? "";
    if (!targetId) {
      const active = await tryLoadTodaySlice();
      targetId = active?.slice_id ?? "";
    }

    if (targetId) {
      sliceId = targetId;
      // Read previously.md and agent.md — FULL content, no truncation
      try { previouslyContent = await readPreviously(targetId); } catch { /* empty */ }
      try { agentCognition = await readAgentTimeline(targetId); } catch { /* empty */ }

      // Extract recent turns — last 3 only (incremental), FULL content no
      // truncation — plus the slice's frontmatter tags.
      try {
        const corePath = sliceIdToFilePath(targetId);
        let raw: string;
        if (input.useDemo) raw = await readFileDemo(corePath);
        else if (input.useGithub) raw = await readFile(corePath, input.repo, input.owner);
        else raw = await readFileLocal(corePath);

        const { turns } = parseTurns(raw);
        recentTurns = turns.slice(-3).map((t) => ({
          role: t.header.includes("(user)") ? "user" : "agent",
          content: t.content,
        }));
        const fmTags = matter(raw).data?.tags;
        if (Array.isArray(fmTags)) {
          currentSliceTags = fmTags.filter((t): t is string => typeof t === "string");
        }
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

  console.log(`[Evolution] Context loaded for slice ${sliceId}: previously=${previouslyContent.length} chars, cognition=${agentCognition.length} chars, turns=${recentTurns.length}, tags=[${currentSliceTags.join(",")}]`);

  return { sliceId, previouslyContent, agentCognition, recentTurns, currentSliceTags };
}

// ─── Step 2: Run Previously Agent, apply mutations, close stream ───────────

export async function finalizeEvolution(
  input: {
    repo: string;
    owner: string;
    useGithub: boolean;
    useDemo: boolean;
    workerModel: import("@/lib/models/registry").ModelConfig;
    /** Previously Agent signal from the trigger (slice_closed / user_correction). */
    signal?: string;
  },
  context: EvolutionContext,
): Promise<void> {
  "use step";

  // Demo mode: evolution is skipped — the route layer never starts this
  // workflow, but we guard defensively in case of direct invocation.
  if (input.useDemo) {
    const writer = getWritable<UIMessageChunk>().getWriter();
    await writer.write({
      type: "data-evolution" as `data-${string}`,
      id: "evolution-result",
      data: {
        running: false,
        changes: { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 },
        hasChanges: false,
        skipped: true,
        reason: "demo",
      },
    } as UIMessageChunk);
    await writer.write({ type: "finish-step" } as UIMessageChunk);
    await writer.write({ type: "finish" } as UIMessageChunk);
    writer.releaseLock();
    const writable = getWritable<UIMessageChunk>();
    await writable.close();
    return;
  }

  const { sliceId, previouslyContent, agentCognition, recentTurns,
          currentSliceTags } = context;

  // Emit reviewing phase
  const writer0 = getWritable<UIMessageChunk>().getWriter();
  await writer0.write({
    type: "data-evolution" as `data-${string}`,
    id: "evolution-progress",
    data: { running: true, step: "reviewing" },
  } as UIMessageChunk);
  writer0.releaseLock();

  // Run Previously Agent — the signal comes from the trigger (slice_closed /
  // user_correction), defaulting to new_observation.
  const signal: PreviouslySignal = VALID_SIGNALS.includes(
    (input.signal ?? "") as PreviouslySignal,
  )
    ? (input.signal as PreviouslySignal)
    : "new_observation";
  const note =
    signal === "slice_closed"
      ? `Slice ${sliceId} closed — deep review of the whole conversation.`
      : signal === "user_correction"
        ? "User confirmed an explicit memory update."
        : "Auto-review of latest conversation.";

  let changes = { added: 0, reinforced: 0, demoted: 0, removed: 0, superseded: 0 };
  let hasChanges = false;
  let error: string | undefined;

  try {
    const result = await runPreviouslyAgent({
      signal,
      note,
      model: input.workerModel,
      currentSliceId: sliceId,
      // Deep mode — read the closed slice's conversation/agent.md for patterns.
      closedSliceId: signal === "slice_closed" ? sliceId : undefined,
      previouslyContent,
      agentCognition,
      recentTurns,
      currentSliceTags,
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

    const updatedCard = result.updatedCard;
    if (result.reasoning) {
      console.log(`[Evolution] reasoning: ${result.reasoning}`);
    }

    // Apply the agent's updated card with mechanical enforcement (7-day recent
    // expiry, section caps, anti-conflict backstop).
    if (updatedCard.trim()) {
      const applied = applyCardUpdate(previouslyContent, updatedCard, sliceId);
      await writePreviously(sliceId, applied.content);
      changes = {
        added: applied.changed ? 1 : 0,
        reinforced: 0,
        demoted: 0,
        removed: applied.droppedRecent,
        superseded: 0,
      };
      hasChanges = applied.changed;
      console.log(
        `[Evolution] card update: changed=${applied.changed}, droppedRecent=${applied.droppedRecent}`,
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
      hasChanges,
      error,
    },
  } as UIMessageChunk);
  await writer1.write({ type: "finish-step" } as UIMessageChunk);
  await writer1.write({ type: "finish" } as UIMessageChunk);
  writer1.releaseLock();

  const writable = getWritable<UIMessageChunk>();
  await writable.close();
}
