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
import { createChatAgent, type ChatAgent } from "@/app/api/agent/agent";
import { buildChatToolsContext } from "@/app/api/agent/tools";
import type {
  TurnInput,
  TurnOutcome,
  StartedLoopRef,
} from "@/lib/chat/turn-types";
import { DEPLOY_GUIDE_URL } from "@/lib/capabilities";
import { annotateCardTimes } from "@/lib/time/relative";
import {
  classifyWorkflowError,
  errorMessage,
  formatErrorDetail,
} from "@/lib/chat/workflow-errors";
import {
  housekeeping,
  finalizeTurn,
} from "./steps";

// ─── Pure helpers (serializable data in, serializable data out) ──────────

/** Final assistant text from the agent's message history. */
export function extractFinalText(messages: ModelMessage[]): string {
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
 * All assistant text across the whole turn, in message order — the intermediate
 * text ("let me look that up…") plus the final answer. Tool calls are dropped.
 *
 * This is what gets stored in the time slice as the agent turn: a faithful
 * text-only snapshot of the turn, keeping both the leading and trailing parts
 * while the tool calls in between are not preserved.
 *
 * `startIndex` bounds collection to THIS turn's output: the workflow hands
 * `agent.stream()` the client history (plus a system message the SDK prepends
 * at index 0), and `result.messages` echoes all of it back. Without a
 * startIndex the stored turn would re-capture the entire history every turn —
 * the v0.7 storage-accumulation bug (each stored agent turn grew into a
 * monotonic superset of all prior assistant text, and content bled across
 * slice boundaries). The caller passes `1 + input.modelMessages.length` to
 * skip the system message + the input history, leaving only this run's steps.
 */
export function extractAllAssistantText(
  messages: ModelMessage[],
  startIndex = 0,
): string {
  const parts: string[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) parts.push(m.content.trim());
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (
          p &&
          typeof p === "object" &&
          (p as { type?: string }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string" &&
          (p as { text: string }).text.trim()
        ) {
          parts.push((p as { text: string }).text.trim());
        }
      }
    }
  }
  return parts.join("\n\n");
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

/**
 * The `question` + `report` pairs of every thinkDeep sub-agent in this turn —
 * folded into the agent.md cognition body so sub-agent research survives in the
 * agent's own timeline (the old `memory/thinking/` store is gone; reports now
 * flow inline as tool results).
 *
 * The question lives in the assistant-side tool-call input, the report in the
 * matching `role: "tool"` result (ModelMessage tool-result output is wrapped as
 * { type: 'json', value }). Any result carrying a non-empty report counts —
 * including interrupted (`ok: false`) ones, whose partial findings are worth
 * preserving in the timeline just as they are in the main agent's reply.
 */
export function extractThinkDeepReports(
  messages: ModelMessage[],
): Array<{ question: string; answer: string; reasoning: string }> {
  const questionsByCallId = new Map<string, string[]>();
  const results: Array<{ question: string; answer: string; reasoning: string }> =
    [];

  for (const m of messages) {
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const part of parts) {
      const p = part as {
        type?: string;
        toolCallId?: string;
        toolName?: string;
        input?: { fragments?: Array<{ question?: unknown }> };
        output?: unknown;
      };

      if (p.type === "tool-call" && p.toolName === "thinkDeep") {
        // The batch carries ALL fragments in one call — remember every question.
        if (typeof p.toolCallId !== "string") continue;
        const input = p.input as
          | { fragments?: Array<{ question?: unknown }>; question?: unknown }
          | undefined;
        const qs = Array.isArray(input?.fragments)
          ? input.fragments
              .map((f) => (typeof f?.question === "string" ? f.question : ""))
              .filter(Boolean)
          : typeof input?.question === "string"
            ? [input.question]
            : [];
        questionsByCallId.set(p.toolCallId, qs);
      }

      if (p.type === "tool-result" && p.toolName === "thinkDeep") {
        if (typeof p.toolCallId !== "string") continue;
        const raw = p.output as { value?: unknown } | undefined;
        const value = (
          raw && typeof raw === "object" && "value" in raw ? raw.value : raw
        ) as
          | {
              fragments?: Array<{
                question?: unknown;
                answer?: unknown;
                reasoning?: unknown;
              }>;
              answer?: unknown;
              reasoning?: unknown;
            }
          | undefined;
        const fallbackQuestions = questionsByCallId.get(p.toolCallId) ?? [];

        // New batch shape: one entry per fragment, matched back by its own
        // question (falling back to the call's question list by index).
        if (Array.isArray(value?.fragments)) {
          value.fragments.forEach((f, i) => {
            const question =
              typeof f.question === "string" && f.question.trim()
                ? f.question
                : (fallbackQuestions[i] ?? "");
            const answer = typeof f.answer === "string" ? f.answer : "";
            const reasoning =
              typeof f.reasoning === "string" ? f.reasoning : "";
            // Keep a fragment if it produced ANYTHING — the answer OR the
            // thinking trail (an interrupted fragment's reasoning is still
            // valuable).
            if (answer.trim() || reasoning.trim()) {
              results.push({ question, answer, reasoning });
            }
          });
          continue;
        }

        // Legacy single-fragment shape — keep for robustness.
        const question = fallbackQuestions[0] ?? "";
        const answer = typeof value?.answer === "string" ? value.answer : "";
        const reasoning =
          typeof value?.reasoning === "string" ? value.reasoning : "";
        if (answer.trim() || reasoning.trim()) {
          results.push({ question, answer, reasoning });
        }
      }
    }
  }

  return results;
}

// ─── Timeout continuation (message assembly) ─────────────────────────────

/**
 * A completed LLM step of an interrupted `agent.stream()` run, captured via
 * `onStepEnd` (the killed step itself never completes — its in-flight partial
 * is lost; the client already saw it via the live stream).
 */
export interface ContinuationStepSnapshot {
  /** Assistant text the step produced ("" when it only called tools). */
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
    isError?: boolean;
  }>;
}

/** Wrap a raw tool output into the ModelMessage tool-result envelope. */
function toToolResultOutput(
  result: ContinuationStepSnapshot["toolResults"][number],
): { type: "text"; value: string } | { type: "error-text"; value: string } | { type: "json"; value: unknown } {
  if (result.isError) {
    const value =
      typeof result.output === "string"
        ? result.output
        : (JSON.stringify(result.output) ?? "tool error");
    return { type: "error-text", value };
  }
  if (typeof result.output === "string") {
    return { type: "text", value: result.output };
  }
  try {
    JSON.stringify(result.output);
    return { type: "json", value: result.output };
  } catch {
    return { type: "text", value: String(result.output) };
  }
}

/**
 * Build the messages for a timeout CONTINUATION re-invocation.
 *
 * The naive version fed back only the partial assistant text, DISCARDING the
 * completed tool calls/results of the interrupted run — so the model either
 * re-derived them (re-running tools) or hallucinated their outcomes. Here each
 * completed step that called tools contributes its assistant tool-call message
 * + the matching tool-result message BEFORE the partial assistant text and the
 * nudge, so the continuation resumes from the committed context.
 *
 * Pure — extracted for unit tests.
 */
export function buildTimeoutContinuation(opts: {
  /** The messages the interrupted stream was invoked with. */
  history: ModelMessage[];
  /** Completed steps of the interrupted run (from onStepEnd), in order. */
  steps: ContinuationStepSnapshot[];
  /** Joined partial assistant text across those steps ("" when none). */
  partialText: string;
  /** The continuation instruction. */
  nudge: string;
}): ModelMessage[] {
  const messages: ModelMessage[] = [...opts.history];

  for (const step of opts.steps) {
    if (step.toolCalls.length === 0) continue;
    messages.push({
      role: "assistant",
      content: step.toolCalls.map((tc) => ({
        type: "tool-call" as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      })),
    });
    // Only results whose call is actually in the assistant message above.
    const results = step.toolResults.filter((tr) =>
      step.toolCalls.some((tc) => tc.toolCallId === tr.toolCallId),
    );
    if (results.length > 0) {
      messages.push({
        role: "tool",
        content: results.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: toToolResultOutput(tr),
        })),
      } as ModelMessage);
    }
  }

  const partial = opts.partialText.trim();
  if (partial) {
    messages.push({ role: "assistant", content: partial });
  }
  messages.push({ role: "user", content: opts.nudge });
  return messages;
}

// ─── System prompt assembly (pure — cache-order matters) ─────────────────

/**
 * Assemble the turn's system prompt. Order is a CACHE decision, not just
 * layout: the provider's prompt cache reuses the longest byte-identical
 * PREFIX across requests. So the STABLE blocks come first (identity
 * constitution, previously card — they barely change across turns), and the
 * VARIABLE blocks last (the per-turn brief, strands menu, evolution notice,
 * demo notice). A changing tail never invalidates the long cacheable head.
 *
 * The full assembled string is also fanned out to thinkDeep sub-agents as
 * `baseSystemPrompt`, so their calls share the same prefix the main agent
 * warmed.
 */
export function assembleSystemPrompt(opts: {
  /** SOUL + "who you're assisting" + DIRECTIVES — stable across turns. */
  identityPrompt: string;
  /** The user card (previously.md) — changes only on evolution. */
  previouslyContent: string;
  /** The per-turn brief (timestamp / intent / continuity / semantic links). */
  turnPriming: string;
  /** Pre-built "## Timeline (recent)…" pointer block, or "" to omit. */
  timelineBrief: string;
  /** Pre-built "## Memory topics…" block, or "" to omit. */
  strandsBlock: string;
  /** Pre-built "[System] A self-evolution…" notice, or "" to omit. */
  evolutionNotice: string;
  /** Pre-built "## Demo mode…" block, or "" to omit. */
  demoNotice: string;
  /**
   * Pre-built "## Subscription bridge…" limitation notice (bridge main model
   * has no kernel tools), or ""/undefined to omit. Optional so existing
   * callers/tests are unaffected.
   */
  bridgeNotice?: string;
  /** "YYYY-MM-DD" — anchors the card-freshness header. */
  dateAnchor: string;
}): string {
  const {
    identityPrompt,
    previouslyContent,
    turnPriming,
    timelineBrief,
    strandsBlock,
    evolutionNotice,
    demoNotice,
    bridgeNotice,
    dateAnchor,
  } = opts;
  return [
    identityPrompt,
    `## What I know about the user (inference model — ${dateAnchor})`,
    previouslyContent,
    "The above is the current profile and operating model — distilled hypotheses, each carrying `refs` to its evidence. If any line seems outdated or contradicts what the user just said, cite its refs and say so; the correction flows into the archive. Every `refs` pointer is a drill-down entry: open the referenced slice with readSlice before citing specifics from a past event — the card answers WHO the user is, not what was said.",
    turnPriming,
    timelineBrief,
    strandsBlock,
    evolutionNotice,
    demoNotice,
    bridgeNotice ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
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
    timelineBrief,
    evolutionResult,
  } = await housekeeping(input);

  // ── Assemble system prompt ──────────────────────────────────────────────

  // Order (standing → beliefs → situational): the STABLE blocks first — the
  // identity constitution (SOUL + "who you're assisting" + DIRECTIVES) then the
  // previously card (changes only on evolution). Together they form the long
  // cacheable prefix the provider's prompt cache reuses across turns instead of
  // re-processing every turn. The VARIABLE blocks come last — the turn brief
  // (timestamp / intent / continuity / semantic links), the strands menu, the
  // evolution notice, the demo notice — so a changing tail never invalidates
  // the stable prefix.
  const dateAnchor = input.startedAtIso.slice(0, 10);
  const systemPrompt = assembleSystemPrompt({
    identityPrompt,
    // Relative-time annotations are added to the INJECTED copy only — the
    // stored card keeps raw ISO dates (see src/lib/time/relative.ts).
    previouslyContent: annotateCardTimes(
      previouslyContent,
      input.startedAtIso,
      input.clientTimezone,
      input.locale,
    ),
    turnPriming,
    timelineBrief: timelineBrief
      ? `${timelineBrief}\nTimeline lines are pointers — if a line looks relevant, read the slice (readSliceSummary / readSlice) before answering from it.`
      : "",
    strandsBlock: strandsMenu
      ? `## Memory topics\n\n${strandsMenu}\nWhen the user mentions these topics, use recall to search for related memories. If a search finds nothing relevant, do not retry it — answer from what you have.`
      : "",
    evolutionNotice: evolutionResult?.ran
      ? `[System] A self-evolution just completed — the previously card was updated${evolutionResult.changed ? "" : " (no change)"}.${evolutionResult.summary ? ` What changed: ${evolutionResult.summary}` : ""} The latest card is provided above. Acknowledge this to the user if they asked for it.`
      : "",
    demoNotice: input.useDemo
      ? `## Demo mode (read-only)\n\nYou are running in demo mode. You can browse sample data, recall past conversations, and search the live web — but **writes are not persisted**. No GitHub repo is connected; you are seeing pre-seeded sample memories.\n\nWhen the user asks to save anything, create memories, or start background tasks, tell them naturally:\n- This is demo mode and data cannot be saved\n- They need to deploy their own instance to unlock full read/write and background loop capabilities\n\nDeployment guide: ${DEPLOY_GUIDE_URL}\n\nIt's perfectly normal for users to explore in demo mode — help them understand what this product can do and what they'll get after deploying.`
      : "",
    // Bridge main model (client mode, PREVIOUSLY_BRAIN=bridge): the model is
    // a local subscription CLI spawned by the Previously client, so NO kernel
    // tools are mounted for this turn (see createChatAgent). The prompt blocks
    // above still name recall/readSlice, so say explicitly that they are not
    // available here — an unannounced tool-less model would hallucinate calls
    // to them. Memory access instead happens on the bridge side: the client
    // spawns the CLI in a per-call skills workspace whose instruction files
    // (CLAUDE.md / AGENTS.md) explain how to read Previously's read-only
    // markdown memory (client repo's affair, not kernel tools).
    bridgeNotice:
      input.modelConfig.sdk === "bridge"
        ? `## Subscription bridge mode\n\nYou are running as the user's local subscription CLI, invoked by the Previously client. Your working directory contains an instruction file (CLAUDE.md or AGENTS.md) explaining how to read Previously's memory — read it first; the memory is read-only markdown on disk. Do not try to save or update memory yourself — conversation persistence is handled outside your process. The kernel tools mentioned elsewhere in this prompt (recall, readSlice, webSearch, delegateTask, …) are NOT available to you here, so do not attempt to call them. Your final reply is rendered verbatim in a chat UI — output only the answer, no preamble or meta-commentary.`
        : "",
    dateAnchor,
  });

  // ── Pro agent ──────────────────────────────────────────────────────────

  /**
   * Hard cap on continuations to guard against infinite loops.
   *
   * NOTE: there is deliberately NO `timeout` and NO `maxOutputTokens` on
   * agent.stream(). The workflow sandbox VM does not provision the
   * `AbortSignal` global, so the SDK's timeout option would crash every turn
   * (`ReferenceError: AbortSignal is not defined`). And `maxOutputTokens` is a
   * project-wide prohibition: it behaves inconsistently across models — with
   * DeepSeek thinking enabled, the reasoning silently eats the shared cap and
   * leaves empty/truncated output. Both levers are gone by design; the step is
   * bounded only by the platform's 300s wall.
   *
   * When a step IS platform-killed (or the model otherwise fails), the error
   * reaches the catch block below where `classifyWorkflowError` decides:
   *   - transient → rethrow (the workflow queue redelivers/retries)
   *   - terminal / model → surface a client-visible explanation
   *   - timeout / abort → bounded CONTINUATION: rebuild the messages from the
   *     interrupted run's completed steps (tool calls + results + partial text,
   *     captured via `onStepEnd`) plus a nudge and re-invoke agent.stream(),
   *     so the agent picks up where it left off instead of dying silently.
   * This is the same mechanism as the token-cap continuation loop below, just
   * triggered from the failure path.
   */
  const MAX_CONTINUATIONS = 5;
  /** How many times a timed-out step may be re-invoked with a continuation nudge. */
  const MAX_TIMEOUT_CONTINUATIONS = 2;
  /** Continuation nudge for a step that was interrupted by the platform. */
  const TIMEOUT_CONTINUE_NUDGE =
    "You were interrupted by a timeout. Continue exactly where you left off — do not repeat what you already wrote, and keep your answer focused so it finishes quickly.";

  // Completed-step snapshots of the in-flight stream, accumulated for the
  // timeout continuation so the re-invoked agent resumes from the COMMITTED
  // context (tool calls + results + text) instead of re-deriving it.
  let interruptedSteps: ContinuationStepSnapshot[] = [];

  const agent = createChatAgent({
    model: input.modelConfig,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    toolsContext: buildChatToolsContext({
      repo: input.repo,
      owner: input.owner,
      useGithub: input.useGithub,
      useDemo: input.useDemo,
      sliceId: slice.slice_id,
      recentTurns: input.recentTurns,
      // The full assembled system prompt — thinkDeep sub-agents reuse it as
      // their prefix so provider prompt-cache hits span main + sub calls.
      baseSystemPrompt: systemPrompt,
      workerModel: input.workerModel,
      // The turn's resolved main model — thinkDeep reuses it (shared context)
      // instead of re-resolving config from GitHub on every fragment step.
      mainModel: input.modelConfig,
      // Read tools pre-render user-local time from these (see time-localize.ts).
      timezone: input.clientTimezone,
      startedAtIso: input.startedAtIso,
      locale: input.locale,
    }),
    // Fire after every COMPLETED LLM step: snapshot its text + tool
    // calls/results for a possible timeout continuation. (The killed step
    // itself never completes, so its in-flight partial is lost — the client
    // already received it via the live stream, and the continuation works
    // from the committed context.)
    onStepEnd: (step) => {
      interruptedSteps.push({
        text: typeof step.text === "string" ? step.text : "",
        toolCalls: (step.toolCalls ?? []).map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
        toolResults: (step.toolResults ?? []).map((tr) => {
          const r = tr as {
            toolCallId: string;
            toolName: string;
            output?: unknown;
            error?: unknown;
          };
          const isError = r.error !== undefined;
          return {
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: isError ? errorMessage(r.error, "tool error") : r.output,
            ...(isError ? { isError: true } : {}),
          };
        }),
      });
    },
  });

  /** Shared stream options (continuation-safe, see below). No maxOutputTokens. */
  const streamOpts = {
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: isStepCount(20),
    sendFinish: false,
    preventClose: true,
  } as const;

  let outcome: TurnOutcome;
  let streamError: unknown = null;
  try {
    let allCognition = "";
    let finalFinishReason = "stop";
    let finalMessages: ModelMessage[] = [];
    let currentMessages = input.modelMessages;
    let continuations = 0;
    let timeoutContinuations = 0;
    /** Client-visible explanation when the turn ends as a terminal error. */
    let turnError: string | undefined;

    // ── The agent loop ────────────────────────────────────────────────────
    // Inline loop — NOT a nested closure: the workflow transform instruments
    // awaits at the top level of the "use workflow" body, so `agent.stream`
    // (self-managed steps) must stay here, exactly as the loop engine does.
    //
    // Tool calls (recall / webSearch / thinkDeep) are handled inline by the
    // WorkflowAgent loop: the executor runs in its own step and the result
    // (e.g. a sub-agent report) is fed straight back to the model on the next
    // step. No separate dispatch / polling / integration pass exists.
    while (true) {
      let result: Awaited<ReturnType<ChatAgent["stream"]>>;
      try {
        result = await agent.stream({
          messages: currentMessages,
          system: systemPrompt,
          ...streamOpts,
        });
      } catch (err) {
        // ── Workflow-error classification → what to do ────────────────────
        const classified = classifyWorkflowError(err);
        // v0.8: log the FULL error on every agent.stream failure. The classify
        // branches below reduce it to a short message (or rethrow it without a
        // word), which leaves transient/timeout/model failures invisible in the
        // function log — this line is the diagnostic trail for the test env.
        console.error(
          `[Turn:${input.turnId}][agent.stream] classified=${classified.kind}\n${formatErrorDetail(err)}`,
        );
        if (classified.kind === "transient") {
          // Infrastructure blip — let the workflow queue retry the run.
          throw err;
        }
        if (classified.kind === "terminal" || classified.kind === "model") {
          // Genuinely terminal — surface an explanation, end the turn.
          finalFinishReason = "error";
          turnError =
            classified.userMessage ?? errorMessage(err, "The workflow run failed.");
          break;
        }
        if (classified.kind === "abort") {
          // Client cancelled (or the SDK aborted) — stop, don't re-invoke.
          finalFinishReason = "interrupted";
          break;
        }
        // timeout (a step was platform-killed / a deadline exceeded) — the
        // dominant failure mode. Bounded CONTINUATION: rebuild the messages
        // from the interrupted run's COMPLETED steps — every finished tool
        // call + its result, then the partial assistant text (segments joined
        // with a blank line) and the nudge — so the model picks up exactly
        // where it left off and re-derives nothing.
        if (++timeoutContinuations > MAX_TIMEOUT_CONTINUATIONS) {
          finalFinishReason = "interrupted";
          turnError =
            "The response was interrupted repeatedly by step timeouts. You can send a new message or click continue to try again.";
          break;
        }
        currentMessages = buildTimeoutContinuation({
          history: currentMessages,
          steps: interruptedSteps,
          partialText: interruptedSteps
            .map((s) => s.text.trim())
            .filter(Boolean)
            .join("\n\n"),
          nudge: TIMEOUT_CONTINUE_NUDGE,
        });
        // The snapshots are now committed into currentMessages — clear them so
        // a LATER timeout carries only THAT run's completed steps.
        interruptedSteps = [];
        // Loop back to re-invoke agent.stream() with the continuation.
        continue;
      }

      allCognition += extractCognition(result.messages, result.steps);
      finalMessages = result.messages;
      finalFinishReason = result.finishReason;

      // This iteration's completed steps are now committed into currentMessages
      // (via the continuation feed below) — reset the snapshots so a LATER
      // timeout only carries the partial from THAT failing call, not the whole
      // turn's earlier output (which would be redundant in the continuation).
      interruptedSteps = [];

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
    }

    // ── Sub-agent reports (thinkDeep) — keep the full research in the timeline ──
    // Extracted ONCE from the final messages (not inside extractCognition, which
    // runs per continuation over the full message history — that would duplicate
    // the reports across token-cap continuations).
    const thinkDeepReports = extractThinkDeepReports(finalMessages);
    if (thinkDeepReports.length > 0) {
      allCognition += "\n### Reasoning fragments";
      for (const { question, answer, reasoning } of thinkDeepReports) {
        allCognition += `\n\n**Q**: ${question}`;
        if (answer) allCognition += `\n\n${answer.slice(0, 2000)}`;
        if (reasoning)
          allCognition += `\n\n<reasoning>\n${reasoning.slice(0, 1000)}\n</reasoning>`;
      }
      allCognition += "\n";
    }

    // The stored agent turn is ALL assistant text across the turn (intermediate
    // text + final answer), in order. Tool calls are not preserved — see
    // extractAllAssistantText.
    //
    // `1 + input.modelMessages.length` skips the system message the SDK
    // prepends (index 0) plus the client history handed to the first
    // agent.stream() call — so only THIS run's assistant text is stored, never
    // the whole conversation (the v0.7 storage-accumulation bug). Continuations
    // are covered: the final result.messages is [system, history, ...contN],
    // and slicing at the original history count captures every continuation's
    // output while excluding prior turns.
    outcome = {
      text: extractAllAssistantText(finalMessages, 1 + input.modelMessages.length),
      finishReason: finalFinishReason,
      startedLoops: extractStartedLoops(finalMessages),
      cognition: allCognition,
      error: turnError,
    };

    // v0.8: make a non-stop end visible in the log. Model errors, timeouts and
    // interruptions otherwise terminate silently — this line records why the
    // turn ended so the test env can trace it against the detail logs above.
    if (finalFinishReason !== "stop") {
      console.error(
        `[Turn:${input.turnId}][turn] ended=${finalFinishReason} text=${outcome.text.length} chars` +
          (turnError ? ` error=${turnError.slice(0, 500)}` : ""),
      );
    }
  } catch (err) {
    streamError = err;
    // Full diagnostic trail for anything the agent loop didn't handle (step
    // failures, extraction bugs, persistence errors). The outcome below only
    // carries errorMessage's one-liner, so this is where the detail lives.
    console.error(
      `[Turn:${input.turnId}][workflow] turn failed\n${formatErrorDetail(err)}`,
    );
    outcome = {
      text: "",
      finishReason: "error",
      startedLoops: [],
      cognition: "",
      error: errorMessage(err, "The workflow run failed."),
    };
  }

  // ── Post-turn persistence ──────────────────────────────────────────────

  await finalizeTurn(slice, outcome, input.turnId);

  if (streamError !== null) {
    throw streamError;
  }
}
