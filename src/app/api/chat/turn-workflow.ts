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
 * indexes, strands, and notes straight to the repo. The workflow is
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
} from "@/lib/chat/turn-types";
import { DEPLOY_GUIDE_URL } from "@/lib/capabilities";
import { annotateCardTimes, localDateKey } from "@/lib/time/relative";
import { formatLocalTime } from "@/lib/turn-priming";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import {
  findOverdueHorizonItems,
  parseCard,
} from "@/lib/episodic/previously-format";
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
 * `agent.stream()` the slice-aligned history window (plus a system message
 * the SDK prepends at index 0), and `result.messages` echoes all of it back.
 * Without a startIndex the stored turn would re-capture the entire history
 * every turn — the v0.7 storage-accumulation bug (each stored agent turn grew
 * into a monotonic superset of all prior assistant text, and content bled
 * across slice boundaries). The caller passes `1 + historyWindow.length` to
 * skip the system message + the input window, leaving only this run's steps.
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

// ─── Slice-aligned history window (pure) ─────────────────────────────────

/**
 * Sanitize a checkpoint carry-over prefix (the previous slice's frozen tail)
 * so it cannot break strict role-alternation providers (Anthropic 400s) once
 * the window's first message — the current USER turn — is appended after it.
 * A raw slice tail can violate the contract twice:
 *
 *   - ORPHAN USER TAIL: a slice interrupted by stop/cancel ends with a user
 *     question that never got its reply. Carried over verbatim it would sit
 *     directly before the current user message — two consecutive user turns.
 *     Trailing non-assistant messages are dropped (the unanswered question
 *     stays recorded in the slice itself; the prefix only carries CONTEXT).
 *   - CONSECUTIVE SAME-ROLE TURNS: a regenerate leaves two agent turns in a
 *     row (the rejected reply + its replacement). Collapsed keeping the LATER
 *     one — the replacement is what the conversation actually settled on.
 *
 * Pure; returns [] when nothing survives (the caller then omits the prefix).
 */
export function sanitizeCheckpointPrefix(
  prefix: ModelMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of prefix) {
    if (out.length > 0 && out[out.length - 1].role === msg.role) {
      out[out.length - 1] = msg; // same role twice in a row — keep the later
    } else {
      out.push(msg);
    }
  }
  while (out.length > 0 && out[out.length - 1].role !== "assistant") out.pop();
  return out;
}

/**
 * Prepend the checkpoint carry-over prefix (the frozen tail of the previous
 * slice, assembled server-side by housekeeping) to the slice-aligned window.
 * The prefix is sanitized first (sanitizeCheckpointPrefix) — an orphan user
 * tail or a regenerate's double agent turn would break strict role
 * alternation against the window's leading user message. Pure: no prefix (or
 * nothing surviving sanitization) → the window is returned unchanged. The
 * prefix is fixed for the slice's whole life, so the request prefix keeps
 * growing append-only across a time_cap/capacity checkpoint boundary.
 *
 * Fallback-window dedup: when the client history was too short to cover the
 * slice's turns, sliceAlignedWindow degrades to EVERYTHING given — which
 * includes the previous slice's tail, i.e. exactly what the prefix already
 * carries. Sending both would show the model the same exchange twice. The
 * window is scanned for the prefix's messages as an ORDERED SUBSEQUENCE
 * (matched by role + content) and the duplicates are dropped. Ordered
 * matching keeps false positives negligible: a legitimately repeated "ok" in
 * the current slice is only dropped when the ENTIRE prefix sequence replays
 * in order — which is precisely the duplicated-tail case.
 */
export function withCheckpointPrefix(
  window: ModelMessage[],
  contextPrefix?: ModelMessage[],
): ModelMessage[] {
  const prefix = contextPrefix ? sanitizeCheckpointPrefix(contextPrefix) : [];
  if (prefix.length === 0) return window;
  let p = 0; // next prefix message awaiting its duplicate in the window
  const deduped = window.filter((m) => {
    if (p < prefix.length && messageKey(m) === messageKey(prefix[p])) {
      p++;
      return false; // already carried by the prefix — drop the duplicate
    }
    return true;
  });
  return [...prefix, ...deduped];
}

/** Stable identity for dedup matching: role + serialized content. */
function messageKey(m: ModelMessage): string {
  return `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
}

/**
 * Cut the slice-aligned history window from the client's message history.
 *
 * The client remains the source of conversation history, but the model only
 * needs what belongs to the CURRENT slice (v0.9): walk the history from the
 * tail until `userTurnsInSlice` user messages are covered — one slice turn ≈
 * one user message plus everything that followed it (assistant text, tool
 * calls/results). A brand-new slice therefore sends just the current user
 * message; a continuing slice resends exactly its own turns, so the request
 * prefix grows append-only within the slice (prefix-cache friendly).
 *
 * `maxMessages` is a pure safety valve (maxTurnsPerSlice × 2) — the slice's
 * capacity signal normally closes it long before the cap matters. When the
 * client's tail is too short to cover the slice's turns, degrade to ALL
 * given messages; the context_lost heuristic in housekeeping (steps.ts
 * checkContextLost) already handles the genuinely-mismatched cases.
 */
export function sliceAlignedWindow(
  modelMessages: ModelMessage[],
  userTurnsInSlice: number,
  maxMessages: number,
): ModelMessage[] {
  const target = Math.max(1, userTurnsInSlice);
  let start = 0; // default: client history too short → everything given
  let usersSeen = 0;
  for (let i = modelMessages.length - 1; i >= 0; i--) {
    if (modelMessages[i].role === "user") {
      usersSeen++;
      if (usersSeen >= target) {
        start = i;
        break;
      }
    }
  }
  let windowed = modelMessages.slice(start);
  if (windowed.length > maxMessages) {
    windowed = windowed.slice(-maxMessages);
    // Don't open mid-exchange: drop leading non-user messages so the window
    // starts on a user turn.
    const firstUser = windowed.findIndex((m) => m.role === "user");
    if (firstUser > 0) windowed = windowed.slice(firstUser);
  }
  return windowed;
}

/**
 * The turn's history window: slice-aligned (plus checkpoint carry-over) for
 * real deployments, the FULL client history in demo mode. Demo writes are
 * no-ops (writeFileDemo), so housekeeping can never recover the previous
 * turn's slice — every turn would mint a fresh one, `userTurnsInSlice` would
 * be 1, and sliceAlignedWindow would shrink to just the current user message:
 * the demo visitor's model would see no conversation history at all. Demo is
 * a read-only preview whose only conversation truth is the client history, so
 * slice alignment is skipped there (and nothing is persisted either way).
 * Pure — extracted for unit tests.
 */
export function buildHistoryWindow(opts: {
  modelMessages: ModelMessage[];
  userTurnsInSlice: number;
  maxMessages: number;
  contextPrefix?: ModelMessage[];
  useDemo?: boolean;
}): ModelMessage[] {
  if (opts.useDemo) return opts.modelMessages;
  return withCheckpointPrefix(
    sliceAlignedWindow(opts.modelMessages, opts.userTurnsInSlice, opts.maxMessages),
    opts.contextPrefix,
  );
}

// ─── Bridge mode — notice + fresh-time injection ─────────────────────────

/**
 * L5b — the subscription-bridge limitation notice, injected as the
 * `bridgeNotice` block only when the turn's main model is a bridge model
 * (`modelConfig.sdk === "bridge"`). Exported so tests can pin the contract.
 *
 * The model is a local subscription CLI spawned by the Previously client, so
 * NO kernel tools are mounted for the turn (see createChatAgent). The prompt
 * blocks above still name recall/readSlice, so the notice must say explicitly
 * that they are not available here — an unannounced tool-less model would
 * hallucinate calls to them. Memory access instead happens on the bridge side
 * through the client's CONSTRAINED read-only reader commands, described by the
 * per-call workspace instruction file (CLAUDE.md / AGENTS.md); past-looking
 * questions are delegated to a recall sub-agent per the workspace
 * `skills/recall.md` spec (materialized by the client from the payload's
 * `skills.recall`, see src/lib/bridge-skills.ts), which returns pointers only.
 */
export const BRIDGE_NOTICE = `## Subscription bridge mode

You are running as the user's local subscription CLI, invoked by the Previously client. Memory access goes through the read-only reader commands (\`previously timeline\`, \`previously strands\`, \`previously slicesummary\`, \`previously readslice\`, \`previously card\`, \`previously agentlog\`) described by the instruction file (CLAUDE.md or AGENTS.md) in your working directory; read it first, and do not read or write the memory directory directly. When a question touches the past, spawn a sub-agent to search per the \`skills/recall.md\` spec in your workspace (if your runtime supports sub-agents) — it navigates the memory index with the read-only reader commands and returns POINTERS (slice ids) only; bring only those pointers back into the main context, then open the slices yourself with \`previously readslice\`. The kernel tools mentioned elsewhere in this prompt (recall, readSlice, webSearch, thinkDeep, delegateTask, …) are NOT available to you here: any thinkDeep guidance elsewhere in this prompt does NOT apply in this mode — use your own native deep-reasoning and search capabilities instead. Conversation persistence and memory evolution are handled outside your process; never try to save or update memory yourself. Your final reply is rendered verbatim in a chat UI — output only the answer, no preamble or meta-commentary.`;

/**
 * Bridge-mode fresh clock read. The system prompt is slice-frozen (prefix
 * caching) and the bridge CLI mounts no kernel tools — so it has no
 * `currentTime` tool to ask for the real "now". Instead the turn stamps the
 * time onto the OUTBOUND tail of the last user message (never the system
 * prompt, never written back to the client history). Zero I/O: the slice's
 * remaining minutes are derived from the slice id itself (its UTC start is
 * encoded in the id, same trick as the currentTime executor). When the
 * remaining time can't be derived (unparseable id, past the cap), only the
 * time part is sent.
 *
 * Pure — `nowIso` is the route-stamped turn start (TurnInput.startedAtIso),
 * so the workflow sandbox never touches a live clock.
 */
export function buildBridgeTimeLine(opts: {
  sliceId: string;
  maxSliceMinutes: number;
  timezone: string;
  nowIso: string;
  /**
   * When provided, the closing hint also names the idle-gap close (silence of
   * this many minutes ends the slice EARLIER than the cap — v0.9.1: the hint
   * used to quote only the time_cap remainder, promising time the idle gap
   * would not grant). The idle timer resets on every message, so it is
   * phrased as a silence threshold, not a countdown.
   */
  idleGapMinutes?: number;
}): string {
  const t = formatLocalTime(opts.nowIso, opts.timezone);
  const offset = t.offset ? `, ${t.offset}` : "";
  let line = `\n\n[Current time: ${t.local} (${t.zone}${offset}) / ${t.utc}`;
  const parsed = parseSliceId(opts.sliceId);
  if (parsed) {
    const startMs = Date.parse(
      `${parsed.y}-${parsed.m}-${parsed.d}T${parsed.hm.slice(0, 2)}:${parsed.hm.slice(2)}:00.000Z`,
    );
    const nowMs = Date.parse(opts.nowIso);
    if (!Number.isNaN(startMs) && !Number.isNaN(nowMs)) {
      const elapsedMin = Math.max(0, Math.floor((nowMs - startMs) / 60_000));
      const remaining = opts.maxSliceMinutes - elapsedMin;
      if (remaining > 0) {
        line += `; slice closes in ~${remaining} min`;
        if (opts.idleGapMinutes !== undefined) {
          line += ` at the latest, or after ~${opts.idleGapMinutes} min of silence`;
        }
      }
    }
  }
  return line + "]";
}

/**
 * Append a line to the LAST user message's text tail (outbound copy — the
 * input array and its message objects are left untouched). No-op when the
 * window carries no user message.
 */
export function appendBridgeTimeSuffix(
  messages: ModelMessage[],
  line: string,
): ModelMessage[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "user") continue;
    out[i] =
      typeof m.content === "string"
        ? { ...m, content: m.content + line }
        : { ...m, content: [...m.content, { type: "text" as const, text: line }] };
    break;
  }
  return out;
}

// ─── System prompt assembly (pure — slice-level freeze) ──────────────────

/**
 * Assemble the turn's system prompt. v0.9: the prompt is FROZEN at slice
 * level — every block is anchored to the slice's start, so the assembled
 * string is byte-identical on every turn of a slice and the provider's
 * automatic prefix cache (DeepSeek) is reused across all of them. The cache
 * reset lands exactly where it costs nothing: at the slice boundary, in sync
 * with the card evolution.
 *
 * Layer order (most stable first — prefix caching matches from the first
 * byte to the first difference):
 *   L0 identityPrompt  — SOUL + "who you're assisting" + DIRECTIVES
 *   L1 previously card — annotated relative to the SLICE-HEAD date; changes
 *                        only when an evolution rewrites the card
 *   L1b directionBlock — the evolved user portrait + hypotheses (direction.md);
 *                        changes when an evolution run lands a new direction —
 *                        including mid-slice (the next turn then sees the fresh
 *                        direction; the prefix-cache drift on those turns is
 *                        accepted deliberately)
 *   L2 static rules    — the fixed card/tooling conventions below
 *   L2b overdueBlock   — Horizon items past their `by` date, derived from the
 *                        RAW card + the slice-head local date: both frozen, so
 *                        the derived block is frozen too
 *   L3 sliceHeadBlock  — slice-start snapshot: local time, date anchors,
 *                        birth continuity, birth-evolution summary, drift hint
 *   L4 timelineBrief   — frozen mode: absolute dates, slices closed before
 *                        this one began
 *   L5 strandsBlock + demoNotice — low-frequency / static
 *   L5b bridgeNotice — client-mode subscription-bridge limitation notice;
 *                        constant for the deployment's brain config
 *
 * Nothing per-turn remains: the `Sent:` timestamp, intent, emotional register
 * and semantic links were retired in v0.9 (the analyzer still runs; its
 * output feeds housekeeping decisions and agent.md). Precise "now" questions
 * go through the currentTime tool.
 *
 * The full assembled string is also fanned out to thinkDeep sub-agents as
 * `baseSystemPrompt`, so their calls share the same prefix the main agent
 * warmed.
 */
export function assembleSystemPrompt(opts: {
  /** SOUL + "who you're assisting" + DIRECTIVES — stable across slices. */
  identityPrompt: string;
  /** The user card (previously.md) — changes only on evolution. */
  previouslyContent: string;
  /**
   * Pre-built direction layer (L1b — the evolved user portrait + hypotheses,
   * hypotheses explicitly marked UNVERIFIED GUESSES), from
   * buildDirectionBlock in src/lib/evolution/direction-agent.ts; ""/undefined
   * omits the layer entirely.
   */
  directionBlock?: string;
  /** Frozen slice-head snapshot block (L3), from buildSliceHeadBlock. */
  sliceHeadBlock: string;
  /** Pre-built frozen "## Timeline (recent)…" pointer block, or "" to omit. */
  timelineBrief: string;
  /** Pre-built "## Memory topics…" block, or "" to omit. */
  strandsBlock: string;
  /** Pre-built "## Demo mode…" block, or "" to omit. */
  demoNotice: string;
  /**
   * Pre-built "## Subscription bridge…" limitation notice (bridge main model
   * has no kernel tools), or ""/undefined to omit. Optional so existing
   * callers/tests are unaffected.
   */
  bridgeNotice?: string;
  /** Pre-built overdue-Horizon block (L2b), or "" when nothing is overdue. */
  overdueBlock: string;
  /** "YYYY-MM-DD" slice-head local date — anchors the card-freshness header. */
  dateAnchor: string;
}): string {
  const {
    identityPrompt,
    previouslyContent,
    directionBlock,
    sliceHeadBlock,
    timelineBrief,
    strandsBlock,
    demoNotice,
    bridgeNotice,
    overdueBlock,
    dateAnchor,
  } = opts;
  return [
    identityPrompt,
    `## What I know about the user — the living recap (${dateAnchor})`,
    previouslyContent,
    directionBlock ?? "",
    "The recap above holds WHAT the user did, is doing, and plans — facts, states, commitments; when a direction layer follows it, that is the evolved user model — WHO the user is (a verified portrait plus explicitly-marked guesses). Every entry carries `refs` to its evidence: if a line seems outdated or contradicts what the user just said, cite its refs and say so — the correction flows into the archive. Each `refs` pointer is a drill-down entry: verify it through recall (or open the referenced slice with readSlice) before citing specifics from a past event — the recap says what happened, not what was said.",
    "GROUNDING RULE — never answer the past from a summary. Everything this prompt says about the past (this card, the timeline one-liners below) is a distilled POINTER, not the event itself; a summary paraphrased as fact is a hallucination in waiting. Before you assert any specific about a past conversation — what was said, decided, promised, felt — the original must already be in THIS conversation: a recall answer from earlier this conversation (its references count), or slice text you opened yourself with readSlice this conversation. With neither at hand, call recall FIRST (or readSlice when you already hold the exact slice id), then answer. Exempt: what the user just said in this conversation, and the slice you are currently in.",
    overdueBlock,
    sliceHeadBlock,
    timelineBrief,
    strandsBlock,
    demoNotice,
    bridgeNotice ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * L2b — overdue Horizon commitments. Derived from the RAW card and the
 * slice-head local date (both frozen for the slice's life), so the derived
 * block is byte-stable within the slice too. The card itself carries the
 * substance (and the `（已逾期 N 天）` annotations); this block restores the
 * pre-v0.9 "proactively ask about outcomes" nudge without any per-turn input.
 */
export function buildOverdueBlock(
  rawCard: string,
  dateAnchor: string,
  locale?: string,
): string {
  const doc = rawCard.trim() ? parseCard(rawCard) : null;
  if (!doc) return "";
  const overdue = findOverdueHorizonItems(doc, dateAnchor);
  if (overdue.length === 0) return "";
  const zh = locale === "zh";
  const items = overdue
    .map((h) => (zh ? `「${h.text}」（by ${h.by}）` : `"${h.text}" (by ${h.by})`))
    .join(zh ? "；" : "; ");
  return zh
    ? `## 逾期承诺\n以下 Horizon 事项已超过其 by 日期——当它们和当下话题相关时，自然地询问用户结果；不要没头没尾地主动追问：${items}`
    : `## Overdue commitments\nThese Horizon items are past their "by" date — when one is relevant to the conversation, naturally ask the user how it turned out; never nag unprompted: ${items}`;
}

// ─── The workflow ────────────────────────────────────────────────────────

export async function turnWorkflow(input: TurnInput): Promise<void> {
  "use workflow";

  // ── Pre-turn steps ─────────────────────────────────────────────────────

  const {
    slice,
    previouslyContent,
    strandsMenu,
    sliceHeadBlock,
    identityPrompt,
    directionBlock,
    timelineBrief,
    contextPrefix,
  } = await housekeeping(input);

  // ── Assemble system prompt ──────────────────────────────────────────────

  // v0.9 slice-level freeze: EVERY input is anchored to the slice's start —
  // the card annotations and freshness header use the slice-head local date,
  // the L3 snapshot / timeline brief are built frozen in housekeeping. Within
  // a slice the assembled string is byte-identical turn over turn, so the
  // provider's prefix cache is reused on every call; the cache resets only at
  // the slice boundary (in sync with the card evolution) or when a mid-slice
  // explicit evolution rewrites the card.
  const dateAnchor =
    localDateKey(slice.start, input.clientTimezone) ?? slice.start.slice(0, 10);
  const systemPrompt = assembleSystemPrompt({
    identityPrompt,
    // Relative-time annotations are added to the INJECTED copy only — the
    // stored card keeps raw ISO dates (see src/lib/time/relative.ts). Anchored
    // to the slice start: the phrases are day-granular, so they can't drift
    // within the slice's 30-minute life.
    previouslyContent: annotateCardTimes(
      previouslyContent,
      slice.start,
      input.clientTimezone,
      input.locale,
    ),
    // L1b — the evolved user portrait + hypotheses, read in housekeeping this
    // turn (post-evolution), so a direction landed mid-slice is what the NEXT
    // turn sees. Within a slice without an evolution it is byte-stable.
    directionBlock: directionBlock ?? "",
    sliceHeadBlock,
    timelineBrief: timelineBrief
      ? `${timelineBrief}\nTimeline lines are pointers — if a line looks relevant, ask recall about it (a natural-language question) before answering from it.`
      : "",
    strandsBlock: strandsMenu
      ? `## Memory topics\n\n${strandsMenu}\nWhen the user mentions these topics, ask recall about related past conversations. If it answers that there is no such memory, do not ask again — answer from what you have.`
      : "",
    demoNotice: input.useDemo
      ? `## Demo mode (read-only)\n\nYou are running in demo mode. You can browse sample data, recall past conversations, and search the live web — but **writes are not persisted**. No GitHub repo is connected; you are seeing pre-seeded sample memories.\n\nWhen the user asks to save anything or create memories, tell them naturally:\n- This is demo mode and data cannot be saved\n- They need to deploy their own instance to unlock full read/write capabilities\n\nDeployment guide: ${DEPLOY_GUIDE_URL}\n\nIt's perfectly normal for users to explore in demo mode — help them understand what this product can do and what they'll get after deploying.`
      : "",
    // Bridge main model (client mode, PREVIOUSLY_BRAIN=bridge): the model is
    // a local subscription CLI spawned by the Previously client, so NO kernel
    // tools are mounted for this turn (see createChatAgent). The static notice
    // (BRIDGE_NOTICE) says so explicitly — an unannounced tool-less model
    // would hallucinate calls to the kernel tools the other blocks name. It is
    // constant for the deployment's brain config, so the freeze is intact.
    bridgeNotice:
      input.modelConfig.sdk === "bridge" ? BRIDGE_NOTICE : "",
    // Derived from the RAW card + the slice-head local date — both frozen, so
    // this block is byte-stable within the slice (see buildOverdueBlock).
    overdueBlock: buildOverdueBlock(
      previouslyContent,
      dateAnchor,
      input.locale,
    ),
    dateAnchor,
  });

  // ── Slice-aligned history window (v0.9) ────────────────────────────────
  // The client still supplies the history, but the model only receives the
  // CURRENT slice's turns: N user turns in the slice → the tail of the client
  // history covering those N user messages. A fresh slice (just closed /
  // first turn) sends only the current user message — UNLESS the slice
  // continues a checkpointed one (continuesFrom from a time_cap/capacity
  // close): then the previous slice's frozen tail (contextPrefix, read
  // server-side by housekeeping) is prepended, so the same conversation
  // continues seamlessly. Within a slice the prefix grows append-only,
  // keeping the provider cache warm; context_lost/idle_gap mismatches were
  // already handled by housekeeping (a new slice → N = 1, no carry-over).
  const userTurnsInSlice = slice.turns.filter((t) => t.role === "user").length;
  const historyWindow = buildHistoryWindow({
    modelMessages: input.modelMessages,
    userTurnsInSlice,
    maxMessages: input.config.slicing.maxTurnsPerSlice * 2,
    contextPrefix,
    // Demo writes never land (demo-fs no-ops), so no active slice survives
    // between turns — aligning to the always-fresh slice would send only the
    // current user message. Demo sends the full client history instead.
    useDemo: input.useDemo,
  });
  if (historyWindow.length !== input.modelMessages.length) {
    console.log(
      `[Turn:${input.turnId}] history window: ${historyWindow.length}/${input.modelMessages.length} messages (slice ${slice.slice_id}, ${userTurnsInSlice} user turns${contextPrefix ? `, +${contextPrefix.length} carried` : ""})`,
    );
  }

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
      // The turn's resolved main model — all sub-agents reuse it (shared
      // context) instead of re-resolving config from GitHub on every step.
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
      // Provider warnings (unsupported settings, silent downgrades such as
      // dropped image parts) never throw — log them so a quiet degradation is
      // visible in the server log.
      const stepWarnings = (step as { warnings?: unknown[] }).warnings;
      if (stepWarnings?.length) {
        console.warn(
          `[Turn:${input.turnId}] model=${input.model} step warnings:`,
          stepWarnings,
        );
      }
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
    // Bridge main model: no kernel tools means no currentTime tool, and the
    // system prompt must stay slice-frozen — so the fresh clock read rides
    // the tail of the LAST user message on the OUTBOUND copy only (the client
    // history is never rewritten). Same length as historyWindow, so the
    // extractAllAssistantText start index below is unaffected.
    let currentMessages =
      input.modelConfig.sdk === "bridge"
        ? appendBridgeTimeSuffix(
            historyWindow,
            buildBridgeTimeLine({
              sliceId: slice.slice_id,
              maxSliceMinutes: input.config.slicing.maxSliceMinutes,
              idleGapMinutes: input.config.slicing.idleGapMinutes,
              timezone: input.clientTimezone,
              nowIso: input.startedAtIso,
            }),
          )
        : historyWindow;
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
    // `1 + historyWindow.length` skips the system message the SDK
    // prepends (index 0) plus the slice-aligned history window handed to the
    // first agent.stream() call — so only THIS run's assistant text is stored,
    // never the whole conversation (the v0.7 storage-accumulation bug).
    // Continuations are covered: the final result.messages is
    // [system, history, ...contN], and slicing at the original window count
    // captures every continuation's output while excluding prior turns.
    outcome = {
      text: extractAllAssistantText(finalMessages, 1 + historyWindow.length),
      finishReason: finalFinishReason,
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
