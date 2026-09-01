/**
 * Strand Consolidator — the LLM consolidation pass for the strand index.
 *
 * The deterministic layer (normalization + normalized-match merge in
 * strands.ts) catches mechanical duplicates (`Apex`/`apex`). But the model
 * itself minted semantic duplicates — typos (`陈勇超`/`陈永超`), the
 * same concept under two names (`心态`/`心态调整`), and concept families
 * (`面试评估`/`面试复盘`/`面试问题`). Those need semantic judgment, which is
 * this module's job: an LLM pass proposes a from→to merge map; the
 * engineering layer applies it (path-union + key removal) and then prunes
 * single-use stale strands.
 *
 * Runs opportunistically at slice close (see housekeeping). Since v0.9 the
 * pass runs through the shared sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts) on the turn's MAIN model — thinking on
 * at low effort, static system prompt (shared base + role), dynamic strand
 * index in the user prompt. Never throws — on any failure it returns the
 * input index unchanged so housekeeping degrades gracefully.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import type { StrandIndex } from "@/lib/episodic/types";
import {
  applyStrandMerges,
  pruneStrands,
} from "@/lib/episodic/strands";

// ─── Config ────────────────────────────────────────────────────────────────

/** Below this many strands, skip the LLM pass (nothing meaningful to dedupe).
 *  Exported: the outsourced (bridge) housekeeping path applies the same gate
 *  when deciding whether to offer merge candidates to the client agent. */
export const MIN_STRANDS_FOR_LLM = 25;
/** Cap on merges the worker may propose per pass (keeps the call cheap). */
const MAX_MERGES = 30;

// ─── Structured output schema ──────────────────────────────────────────────

const consolidateSchema = z.object({
  merges: z
    .array(
      z.object({
        from: z.string().describe("The strand key to merge INTO `to` (the redundant/less-canonical name)."),
        to: z.string().describe("The strand key to keep (the canonical name). MUST already exist in the index."),
        reason: z.string().describe("One short phrase: typo | same concept | same person/entity."),
      }),
    )
    .max(MAX_MERGES)
    .describe("Near-duplicate strand keys to merge. Empty when the index is already clean."),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

// ─── Prompt ────────────────────────────────────────────────────────────────

/**
 * Static role block — the system prompt (shared base + this) never changes
 * between calls (prefix-cache hits). The dynamic strand index goes into the
 * user prompt.
 */
const CONSOLIDATOR_SYSTEM = buildSubAgentSystem(`You are the strand-consolidation agent for a personal memory system.

A "strand" is a keyword threading through time slices (slices/YYYY/MM/DD/HHMM). The user message carries the current strand index, mapping each strand to how many slices carry it.

## Task

Find NEAR-DUPLICATE strands — the same durable concept, person, company, or topic recorded under two or more names — and propose merging them into ONE canonical key.

Merge when they clearly denote the same thing:
- Typos / alternate spellings (陈勇超 vs 陈永超)
- Same concept in two names (心态 vs 心态调整; 面试评估 vs 面试复盘)
- Same entity written differently (Apex vs apex — case variants)
- Concept + derived-subtopic that are really the same thread (plaud vs plaud策略)

DO NOT merge:
- Distinct concepts that merely share a word (公司注册 vs 公司评估)
- A broad topic with a genuinely separate subtopic you'd want to recall independently
- Keys with zero slices in common and no clear same-concept basis

## Rules

1. Every \`to\` key MUST already exist in the provided index.
2. Prefer keeping the more specific / more used / more canonical name as \`to\`.
3. Do not propose a chain (A→B and B→C in the same pass). Each merge is independent: from → to.
4. When in doubt, do NOT merge. Precision over recall — a wrong merge destroys thread history.
5. Empty merges is a valid answer when the index is already clean.

## Output

Call \`consolidateOutput\` with your merge map (or empty) + a short reasoning note.`);

/** The dynamic user prompt: the current strand index. */
function buildPrompt(strands: StrandIndex): string {
  const rows = Object.entries(strands)
    .map(([key, paths]) => `- ${key} (${paths.length} slice${paths.length === 1 ? "" : "s"})`)
    .join("\n");

  return `## Current strand index

${rows}

Propose the merge map per your instructions.`;
}

// ─── Sub-agent call ────────────────────────────────────────────────────────

async function proposeMerges(
  model: ModelConfig,
  strands: StrandIndex,
): Promise<Array<{ from: string; to: string }>> {
  const result = await runSubAgent({
    model,
    system: CONSOLIDATOR_SYSTEM,
    prompt: buildPrompt(strands),
    temperature: 0,
    maxSteps: 50,
    timeoutMs: 30_000,
    tools: {
      consolidateOutput: tool({
        description: "Report the strand merge map.",
        inputSchema: consolidateSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "consolidateOutput",
    reportSchema: consolidateSchema,
    progress: { toolName: "strand-consolidator" },
  });

  // The runner never throws: a timeout / model failure / missing or invalid
  // report all degrade to an empty merge map.
  if (!result.ok || !result.report) return [];

  // Sanitize: drop any proposal whose `to` key doesn't exist or that is a no-op.
  return result.report.merges.filter(
    (m) => m.from !== m.to && strands[m.to] !== undefined,
  );
}

// ─── Public entry ──────────────────────────────────────────────────────────

export interface ConsolidationResult {
  strands: StrandIndex;
  pruned: string[];
  merges: Array<{ from: string; to: string }>;
  llmPassSkipped: boolean;
}

/**
 * Consolidate a strand index: deterministic pruning always runs; the LLM
 * merge pass runs only when the index is large enough to be worth it.
 * Returns the consolidated index + what was merged/pruned.
 */
export async function consolidateStrands(
  strands: StrandIndex,
  model: ModelConfig,
): Promise<ConsolidationResult> {
  // ── 1. Deterministic pruning first (cheap, always safe) ─────────────
  const { strands: afterPrune, pruned } = pruneStrands(strands);

  // ── 2. LLM merge pass (only when big enough to matter) ──────────────
  let merges: Array<{ from: string; to: string }> = [];
  let llmPassSkipped = false;
  if (Object.keys(afterPrune).length < MIN_STRANDS_FOR_LLM) {
    llmPassSkipped = true;
  } else {
    try {
      merges = await proposeMerges(model, afterPrune);
      if (merges.length > 0) {
        applyStrandMerges(afterPrune, merges);
      }
    } catch {
      // Worker unavailable — return the pruned index as-is.
      merges = [];
    }
  }

  return { strands: afterPrune, pruned, merges, llmPassSkipped };
}
