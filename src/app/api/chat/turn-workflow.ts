/**
 * Durable chat-turn workflow — every chat turn runs inside one of these.
 *
 * The deterministic controller: NO direct I/O and no Node.js modules in its
 * import graph. It threads the time-slice by value through the steps,
 * re-binding it after each mutating step (the module-global `activeSlice` is
 * unusable here — steps run in separate invocations).
 *
 * The Pro agent loop runs HERE, in the workflow body, via WorkflowAgent
 * (AI SDK 7 `@ai-sdk/workflow`): each LLM call and each tool call becomes its
 * own durable step (tool executors are standalone `"use step"` functions in
 * src/app/api/agent/tool-executors.ts). Everything else — slice housekeeping,
 * Flash recall, prompt assembly, persistence — lives behind the `"use step"`
 * functions in ./steps, imported here by reference only.
 *
 * GitHub remains the source of truth for memory: the steps write slices,
 * indexes, strands, notes, and loop files straight to the repo. The workflow is
 * only the execution container that makes the turn durable and resumable.
 *
 * Lives under src/app so the `withWorkflow` loader (which scans app/src/app by
 * default) picks up the `"use workflow"` directive.
 */
import { isStepCount, type ModelMessage } from "ai";
import { getWritable } from "workflow";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { createChatAgent } from "@/app/api/agent/agent";
import { buildChatToolsContext } from "@/app/api/agent/tools";
import type {
  TurnInput,
  TurnOutcome,
  StartedLoopRef,
} from "@/lib/chat/turn-types";
import {
  housekeeping,
  metadataUpdate,
  updatePreviously,
  finalizeTurn,
} from "./steps";

// ─── Pure helpers (serializable data in, serializable data out) ──────────

/** Final assistant text from the agent's message history. */
function extractFinalText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" &&
            p !== null &&
            (p as { type?: string }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string"
        )
        .map((p) => p.text)
        .join("");
    }
    return "";
  }
  return "";
}

/**
 * Mechanically extract the agent's cognitive process from its message history
 * AND step results.
 *
 * IMPORTANT: In the WorkflowAgent, `result.messages` does NOT contain reasoning
 * parts — the agent strips them when building `conversationPrompt` (see
 * stream-text-iterator.ts:399-415). Reasoning is preserved only in
 * `result.steps[].reasoning`. Tool-call→result statuses are resolved from
 * tool-role messages in `result.messages`.
 *
 * This function merges both sources:
 *   - Reasoning + tool calls → from steps
 *   - Tool results (ok/error) → from messages
 */
export function extractCognition(
  messages: ModelMessage[],
  steps: Array<{
    reasoning?: Array<{ type: string; text: string }>;
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  }>,
): string {
  const lines: string[] = [];

  // Collect tool-call→result pairs by matching toolCallId across messages.
  const toolResults = new Map<string, { ok: boolean; error?: string }>();

  for (const m of messages) {
    if (m.role !== "tool") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const part of parts) {
      const p = part as { type?: string; toolCallId?: string; toolName?: string; output?: unknown; isError?: boolean };
      if (p.type !== "tool-result" || typeof p.toolCallId !== "string") continue;
      const isError = p.isError === true;
      const outputStr = typeof p.output === "string" ? p.output : "";
      toolResults.set(p.toolCallId, {
        ok: !isError,
        error: isError ? (outputStr.slice(0, 200) || "unknown error") : undefined,
      });
    }
  }

  // Process each step: reasoning + tool calls with result status from messages.
  for (const step of steps) {
    // ── Reasoning (from steps — NOT available in messages) ──────────
    if (step.reasoning && step.reasoning.length > 0) {
      lines.push("\n### Thinking");
      for (const r of step.reasoning) {
        if (typeof r.text === "string" && r.text.trim()) {
          lines.push(r.text);
        }
      }
    }

    // ── Tool calls (from steps, enriched with result status from messages) ──
    if (step.toolCalls && step.toolCalls.length > 0) {
      lines.push("\n### Tools");
      for (const tc of step.toolCalls) {
        const params = summarizeToolInput(tc.input);
        const result = toolResults.get(tc.toolCallId);
        const status = result
          ? result.ok
            ? "ok"
            : `error: ${result.error}`
          : "?";
        lines.push(`- \`${tc.toolName}\`(${params}) → ${status}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

/** Compact single-line representation of tool parameters. */
function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .slice(0, 5); // cap at 5 params to keep each line scannable
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v.slice(0, 80)}${v.length > 80 ? "…" : ""}"` : JSON.stringify(v)}`)
    .join(", ");
}

/**
 * Successful startLoop tool results → slice writeback refs.
 *
 * Extracted from the agent's MESSAGE history, not `result.steps`: after the
 * workflow serialization boundary a step's `content` carries only the
 * tool-call part (the tool RESULT lands in a `role: "tool"` message), so the
 * `toolResults` getter on steps is always empty here. Tags come from the
 * matching assistant tool-call input; the loopId from the tool result.
 */
function extractStartedLoops(messages: ModelMessage[]): StartedLoopRef[] {
  const tagsByCallId = new Map<string, string[]>();
  const refs: StartedLoopRef[] = [];

  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      for (const part of m.content) {
        const p = part as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          input?: { tags?: unknown };
        };
        if (
          p.type === "tool-call" &&
          p.toolName === "startLoop" &&
          typeof p.toolCallId === "string"
        ) {
          const tags = Array.isArray(p.input?.tags)
            ? p.input.tags.filter((t): t is string => typeof t === "string")
            : [];
          tagsByCallId.set(p.toolCallId, tags);
        }
      }
    } else if (m.role === "tool") {
      for (const part of m.content) {
        const p = part as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          output?: unknown;
        };
        if (p.type !== "tool-result" || p.toolName !== "startLoop") continue;
        // ModelMessage tool-result output is wrapped ({ type: 'json', value }).
        const raw = p.output as { value?: unknown } | undefined;
        const value = (
          raw && typeof raw === "object" && "value" in raw ? raw.value : raw
        ) as { ok?: unknown; loopId?: unknown } | undefined;
        if (!value || value.ok !== true || typeof value.loopId !== "string") {
          continue;
        }
        refs.push({
          loopId: value.loopId,
          tags: tagsByCallId.get(p.toolCallId ?? "") ?? [],
        });
      }
    }
  }
  return refs;
}

// ─── The workflow ────────────────────────────────────────────────────────

export async function turnWorkflow(input: TurnInput): Promise<void> {
  "use workflow";

  // ── Pre-turn steps ─────────────────────────────────────────────────────

  const { slice, closedSlice } = await housekeeping(input);
  const meta = await metadataUpdate(input, slice);
  const belief = await updatePreviously(input, meta.slice, closedSlice);

  // ── Assemble system prompt (lightweight — no Flash injection) ──────────

  const systemPrompt = `${belief.userProfile}

## What I understand about you

${belief.previouslyContent}
This is my current understanding of who you are and how you work. If any of this is wrong or outdated, tell me and I'll update it.

## Memory access rules

When you need context from past conversations, follow this order:

1. **Recall first.** Call \`recall\` to search the episodic memory. The recall agent returns pointers (which slices, which turns, why relevant). Never call readSlice, readTimeline, readStrand, or listStrands before recall has returned results.
2. **Deep-read if needed.** After recall returns, call \`readSlice\` to get content from specific slices. Use the \`range\` parameter to fetch only what you need:
   - \`range: { type: "last", count: 3 }\` — get the last 3 turns of a slice
   - \`range: { type: "turns", indices: [0, 5, 7] }\` — get specific turn numbers
   - \`range: { type: "date", after: "2026-07-24T00:00:00Z" }\` — get turns after a date
   - Omit \`range\` to get the full slice (use sparingly for large slices)
3. **Explore more if needed.** Use \`readStrand\` or \`readTimeline\` only to follow up on leads from the recall results.

Think of recall as your search engine — you must search before you read. Reading slices blindly without recall is like opening random files without knowing what's inside.

**Think in time.** When recall returns results, prefer more recent slices — the user's current state is usually what matters most. When you cite past conversations, include a time anchor ("Last Tuesday you mentioned…" not just "You mentioned…") so the user knows you're placing it correctly on their timeline. What changed since last time is often more useful than what was said.

You can search the live web with the webSearch tool when you need current or external information beyond the user's memory and your knowledge. Weave what it finds into your prose with inline citations where relevant.
You can start durable background loops with the startLoop tool. When the user asks for continuous or background work, or when you judge a task is large or long-running enough to work autonomously rather than answer inline, call startLoop with a clear, self-contained goal — it keeps working after this turn and records its progress to memory. Tell the user when you start one. Don't use it for anything you can answer right now.`;

  // ── Pro agent ──────────────────────────────────────────────────────────

  const agent = createChatAgent({
    modelId: input.model,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    toolsContext: buildChatToolsContext({
      repo: input.repo,
      owner: input.owner,
      useGithub: input.useGithub,
      useDemo: input.useDemo,
      sliceId: slice.slice_id,
    }),
  });

  let outcome: TurnOutcome;
  let streamError: unknown = null;
  try {
    const result = await agent.stream({
      messages: input.modelMessages,
      system: systemPrompt,
      writable: getWritable<ModelCallStreamPart>(),
      stopWhen: isStepCount(20),
      sendFinish: false,
      preventClose: true,
    });
    outcome = {
      text: extractFinalText(result.messages),
      finishReason: result.finishReason,
      startedLoops: extractStartedLoops(result.messages),
      cognition: extractCognition(result.messages, result.steps),
    };
  } catch (err) {
    streamError = err;
    outcome = { text: "", finishReason: "error", startedLoops: [], cognition: "" };
  }

  // ── Post-turn persistence ──────────────────────────────────────────────

  await finalizeTurn(belief.slice, outcome, input.turnId);

  if (streamError !== null) {
    throw streamError;
  }
}
