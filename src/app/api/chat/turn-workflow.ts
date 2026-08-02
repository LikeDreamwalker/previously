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
import { DEPLOY_GUIDE_URL } from "@/lib/capabilities";
import {
  housekeeping,
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
  steps: unknown,
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
  const stepsArray = Array.isArray(steps) ? steps : [];
  for (const step of stepsArray) {
    const stepObj = step as Record<string, unknown>;
    // ── Reasoning (from steps — NOT available in messages) ──────────
    const reasoning = stepObj.reasoning as Array<{ type: string; text?: string; data?: unknown }> | undefined;
    if (reasoning && reasoning.length > 0) {
      lines.push("\n### Thinking");
      // Reasoning arrives as per-delta fragments (often token-sized) that must
      // be concatenated — emitting each fragment on its own line would produce
      // one-token-per-line output. Join the fragments, then wrap at paragraph
      // boundaries.
      const text = reasoning
        .map((r) => {
          const content: unknown = typeof r.text === "string" ? r.text : r.data;
          return typeof content === "string" ? content : "";
        })
        .join("");
      for (const paragraph of text.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed) lines.push(trimmed);
      }
    }

    // ── Tool calls (from steps, enriched with result status from messages) ──
    const toolCalls = stepObj.toolCalls as Array<{ toolCallId: string; toolName: string; input: unknown }> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      lines.push("\n### Tools");
      for (const tc of toolCalls) {
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

  const {
    slice,
    previouslyContent,
    strandsMenu,
    turnPriming,
    identityPrompt,
  } = await housekeeping(input);

  // ── Assemble system prompt ──────────────────────────────────────────────

  // Order (situational → standing → beliefs): the turn brief first, then the
  // identity block (SOUL + "who you're assisting" + DIRECTIVES — the memory
  // access rules now live inside DIRECTIVES), then previously (rarely
  // changes), then the strands menu, then the demo notice.
  const dateAnchor = input.startedAtIso.slice(0, 10);
  const systemPrompt = [
    turnPriming,
    identityPrompt,
    `## What I know about you (as of ${dateAnchor})`,
    previouslyContent,
    "The above is my current understanding of you. Tell me if anything is outdated or wrong and I'll update it.",
    strandsMenu
      ? `## Memory topics\n\n${strandsMenu}\nWhen the user mentions these topics, use recall to search for related memories.`
      : "",
    input.useDemo
      ? `## Demo mode (read-only)\n\nYou are running in demo mode. You can browse sample data, recall past conversations, and search the live web — but **writes are not persisted**. No GitHub repo is connected; you are seeing pre-seeded sample memories.\n\nWhen the user asks to save anything, create memories, or start background tasks, tell them naturally:\n- This is demo mode and data cannot be saved\n- They need to deploy their own instance to unlock full read/write and background loop capabilities\n\nDeployment guide: ${DEPLOY_GUIDE_URL}\n\nIt's perfectly normal for users to explore in demo mode — help them understand what this product can do and what they'll get after deploying.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── Pro agent ──────────────────────────────────────────────────────────

  /**
   * Safety cap on tokens per LLM call. Each `doStreamStep` inside the
   * WorkflowAgent is a single Vercel Workflow step with a 5‑minute hard
   * limit. 8000 tokens keeps even a slow thinking-model generation under
   * that ceiling. When the model hits this cap mid-response, the
   * continuation loop below feeds its output back so it can pick up
   * where it left off — the user sees a single continuous stream.
   */
  const MAX_OUTPUT_TOKENS = 8_000;
  /** Hard cap on continuations to guard against infinite loops. */
  const MAX_CONTINUATIONS = 5;

  const agent = createChatAgent({
    model: input.modelConfig,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    toolsContext: buildChatToolsContext({
      repo: input.repo,
      owner: input.owner,
      useGithub: input.useGithub,
      useDemo: input.useDemo,
      sliceId: slice.slice_id,
      recentTurns: input.recentTurns,
      workerModel: input.workerModel,
    }),
  });

  let outcome: TurnOutcome;
  let streamError: unknown = null;
  try {
    let allText = "";
    let allCognition = "";
    let finalFinishReason = "stop";
    let finalMessages: ModelMessage[] = [];
    let finalSteps: unknown[] = [];
    let currentMessages = input.modelMessages;
    let currentSystem: string | undefined = systemPrompt;
    let continuations = 0;

    while (true) {
      const result = await agent.stream({
        messages: currentMessages,
        ...(currentSystem ? { system: currentSystem } : {}),
        writable: getWritable<ModelCallStreamPart>(),
        stopWhen: isStepCount(20),
        sendFinish: false,
        preventClose: true,
      });

      allText += extractFinalText(result.messages);
      allCognition += extractCognition(result.messages, result.steps);
      finalMessages = result.messages;
      finalSteps = result.steps;
      finalFinishReason = result.finishReason;

      // Only loop when the model hit the token cap before it was done.
      if (result.finishReason !== "length") break;
      if (++continuations >= MAX_CONTINUATIONS) break;

      // Feed the model's output back with a continuation nudge. Strip the
      // old system message (it's embedded at index 0) and pass the system
      // prompt fresh so `standardizePrompt` doesn't see a duplicate.
      currentMessages = [
        ...result.messages.filter((m) => m.role !== "system"),
        {
          role: "user" as const,
          content:
            "You were cut off mid-response. Continue exactly where you left off — do not repeat anything you already said.",
        },
      ];
      currentSystem = systemPrompt;
    }

    outcome = {
      text: allText,
      finishReason: finalFinishReason,
      startedLoops: extractStartedLoops(finalMessages),
      cognition: allCognition,
    };
  } catch (err) {
    streamError = err;
    outcome = { text: "", finishReason: "error", startedLoops: [], cognition: "" };
  }

  // ── Post-turn persistence ──────────────────────────────────────────────

  await finalizeTurn(slice, outcome, input.turnId);

  if (streamError !== null) {
    throw streamError;
  }
}
