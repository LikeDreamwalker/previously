/**
 * Bridge language model — an AI SDK custom LanguageModel (spec v3) that runs
 * the chat's MAIN model through the local subscription bridge instead of a
 * provider API. Registered only in client mode with PREVIOUSLY_BRAIN=bridge
 * (see ./registry); cloud mode never constructs it.
 *
 * How it works: the full prompt is serialized into a text transcript, split
 * into `{ task, context }` (task = the final user message, context = system
 * prompt + prior history), and written as JSON to the bridge command's stdin
 * (PREVIOUSLY_BRIDGE_CMD, default `previously bridge-exec` — the local
 * Claude/Codex/Kimi CLI adapter shipped by the client). The bridge's stdout
 * is the generated text. Streaming: when the CLI emits protocol-2 `{"delta"}`
 * lines (claude adapter), doStream forwards them as live text-delta parts and
 * reconciles to the envelope `result` at completion (the result wins); with
 * no deltas (codex/kimi, legacy CLIs) it honestly replays the one-shot result
 * as a single text delta.
 *
 * Structured reports (sub-agents): when the call offers function tools (the
 * unified sub-agent runner's report tool, plus recall's search tools), a
 * plain-text tool protocol is appended to the task: the CLI is told to end
 * its reply with a single JSON object `{"tool": "<name>", "input": {...}}`.
 * That JSON tail is parsed back into a real V3 tool-call part — tool-input
 * start/delta/end + tool-call — so `extractToolReport` and the step runtime
 * work unchanged. Kernel tools offered alongside the report tool (recall's
 * readGlobalTimeline/readStrand/readTimelineWindow) DO execute server-side
 * in the step runtime; their results come back as tool messages in the next
 * doStream round and reach the CLI as `[tool result: ...]` transcript text.
 * `toolChoice: "required"` / `{type:"tool"}` without a valid JSON tail is a
 * fatal BridgeModelError ("invalid-report") — output is never faked. With
 * `toolChoice: "auto"` a plain-text answer (no JSON tail) is returned as
 * text, honestly ending the loop.
 *
 * Live activity (protocol 2): when the CLI streams tool-activity events
 * (see bridge.ts), doStream forwards them as `data-phase` chunks written
 * DIRECTLY to the workflow run's writable — one "Working…" phase whose
 * summaries accumulate the CLI's human lines. (They cannot ride the model
 * stream: the AI SDK step transform rejects unknown chunk types.)
 *
 * Limitations (by design, not silently hidden):
 *   - The chat agent is still constructed WITHOUT kernel tools when this
 *     model is selected (see createChatAgent in src/app/api/agent/agent.ts);
 *     the text tool protocol exists for sub-agent calls. Memory reads work
 *     on the bridge side via the per-call skills workspace the client spawns
 *     (CLAUDE.md / AGENTS.md), not kernel tools.
 *   - Provider-executed tools (web search etc.) cannot be exposed — warned.
 *   - No token usage accounting — usage fields are reported as undefined.
 *   - Bridge failures (missing binary, non-zero exit, timeout, empty output,
 *     a missing required report tail) THROW as model errors so the turn
 *     workflow surfaces them honestly; output is never faked (design
 *     doc/design/v0.9-client.md §8).
 *
 * Workflow serialization: the WorkflowAgent hands this instance across the
 * workflow→step boundary, so the class carries a static `classId` +
 * WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE pair, registered for the step
 * runtime in src/app/api/agent/register-model-classes.ts (same pattern as the
 * DeepSeek/Anthropic/OpenAI model classes).
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import {
  getBridgeCommand,
  getBridgeTimeoutMs,
  runBridge,
  splitBridgeCommand,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_MAX_RESULT_CHARS_V2,
  type BridgeEvent,
  type BridgeFailureReason,
} from "@/lib/bridge";
import { bridgeAgentFromModelId } from "./registry";
import { RECALL_SKILL_DOC } from "@/lib/bridge-skills";

// Global-registry symbols shared with @workflow/serde (Symbol.for — safe to
// recreate here without importing the transitive package).
const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

/** Stable serialization id — both bundles are built from the same source. */
const BRIDGE_MODEL_CLASS_ID =
  "class//previously-bridge@0//BridgeChatLanguageModel";

/** Usage is unknown for a subprocess bridge — every field honestly undefined. */
const UNKNOWN_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Process-unique id source for parsed tool calls (per-process is enough:
 *  ids must only be unique across one turn's tool calls). */
let toolCallCounter = 0;

// ─── Prompt → { task, context } serialization ─────────────────────────────

/** Render one prompt message as a `[Role]` transcript section. */
function renderMessage(message: LanguageModelV3Message): string {
  const role =
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  if (typeof message.content === "string") {
    return `[${role}]\n${message.content}`;
  }
  const parts = message.content.map((part) => {
    switch (part.type) {
      case "text":
        return part.text;
      case "file":
        return `[file: ${part.mediaType}]`;
      case "reasoning":
        return `[reasoning]\n${part.text}`;
      case "tool-call":
        return `[tool call: ${part.toolName}] ${JSON.stringify(part.input)}`;
      case "tool-result":
        return `[tool result: ${part.toolName}] ${JSON.stringify(part.output)}`;
      default:
        return `[${(part as { type: string }).type}]`;
    }
  });
  return `[${role}]\n${parts.join("\n")}`;
}

/**
 * Split a model prompt into the bridge payload: the final user message is
 * the `task`, everything before it (system prompt + history) is the
 * `context`. When the prompt doesn't end in a user message (shouldn't happen
 * on the chat path), the whole transcript is the task.
 *
 * `phase: "chat"` marks the payload as the chat phase (the client picks its
 * per-phase skill workspace document from it; older clients ignore the
 * unknown field). Chat-phase payloads also carry `skills` — the static skill
 * specs (src/lib/bridge-skills.ts) the client materializes into the workspace
 * (skills/recall.md); their `{{PREVIOUSLY_CMD}}` placeholders are filled by
 * the client, never here.
 */
export function promptToBridgePayload(prompt: LanguageModelV3Prompt): {
  task: string;
  context: string | null;
  phase: "chat";
  skills: { recall: string };
} {
  const transcript = prompt.map(renderMessage);
  const last = prompt[prompt.length - 1];
  const skills = { recall: RECALL_SKILL_DOC };
  if (last?.role === "user" && Array.isArray(last.content)) {
    const task = last.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n")
      .trim();
    if (task) {
      const context = transcript.slice(0, -1).join("\n\n");
      return { task, context: context || null, phase: "chat", skills };
    }
  }
  return { task: transcript.join("\n\n"), context: null, phase: "chat", skills };
}

/** Warnings for call options the bridge cannot honor. */
export function bridgeCallWarnings(
  options: LanguageModelV3CallOptions,
): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  // Function tools ARE supported via the text tool protocol; provider-
  // executed tools (web search, …) cannot be exposed to a local CLI.
  const providerTools = (options.tools ?? []).filter(
    (t) => t.type !== "function",
  );
  if (providerTools.length > 0) {
    warnings.push({
      type: "unsupported",
      feature: "tools",
      details:
        "Provider-executed tools cannot be exposed to the subscription " +
        "bridge CLI and were dropped: " +
        providerTools.map((t) => t.name).join(", "),
    });
  }
  if (options.responseFormat?.type === "json") {
    warnings.push({
      type: "unsupported",
      feature: "responseFormat",
      details:
        "The subscription bridge has no JSON mode; the response is plain text.",
    });
  }
  return warnings;
}

// ─── Text tool protocol (structured reports over a plain-text bridge) ─────

interface BridgeFunctionTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** The function tools offered for this call (provider tools excluded). */
function collectFunctionTools(
  options: LanguageModelV3CallOptions,
): BridgeFunctionTool[] {
  return (options.tools ?? [])
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
}

/**
 * Build the plain-text tool protocol instruction appended to the task when
 * the call offers function tools. Returns null when no tools apply (no
 * function tools, or toolChoice "none") — the legacy plain-text path.
 *
 * The CLI cannot execute anything: it is asked to END its reply with one
 * JSON object `{"tool": "<name>", "input": {...}}`. The bridge model parses
 * that tail back into a V3 tool-call part; tools with a server-side execute
 * (recall's search tools) then actually run in the step runtime and their
 * results return as `[tool result: ...]` transcript text in the next round.
 */
export function buildBridgeToolInstruction(
  options: LanguageModelV3CallOptions,
): string | null {
  if (options.toolChoice?.type === "none") return null;
  const tools = collectFunctionTools(options);
  if (tools.length === 0) return null;

  const listing = tools
    .map(
      (t) =>
        `- ${t.name}${t.description ? `: ${t.description}` : ""}\n` +
        `  Input JSON schema: ${JSON.stringify(t.inputSchema)}`,
    )
    .join("\n");

  const tc = options.toolChoice;
  const requirement =
    tc?.type === "tool"
      ? `You MUST end your reply with the JSON tool call for "${tc.toolName}".`
      : tc?.type === "required"
        ? "You MUST end your reply with a JSON tool call for one of the tools above."
        : "If no tool call is needed, reply with plain text only — no JSON tail.";

  return (
    `[Tool protocol — the caller executes tools, you only request them]\n` +
    `Available tools:\n${listing}\n\n` +
    `To call a tool, END your reply with a final line containing ONLY a JSON ` +
    `object of the form {"tool": "<name>", "input": {...}} matching that ` +
    `tool's input schema. Any text before that line is your regular reply. ` +
    `${requirement}`
  );
}

export interface BridgeExtractedCall {
  /** Prose before the JSON tail (stays a normal text part). */
  text: string;
  toolCall: { toolName: string; input: unknown };
}

/**
 * Parse the CLI's final text for the tool protocol's JSON tail: the LAST
 * balanced JSON object that ends the reply, shaped `{"tool": name, "input":
 * {...}}` with `tool` naming one of the offered tools (or exactly
 * `forcedToolName` when toolChoice pinned one). Returns null when there is
 * no valid tail — the caller then keeps the whole output as text (auto) or
 * fails (required).
 */
export function extractBridgeToolCall(
  raw: string,
  toolNames: ReadonlySet<string>,
  forcedToolName?: string,
): BridgeExtractedCall | null {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith("}")) return null;
  let i = trimmed.lastIndexOf("{");
  while (i >= 0) {
    const candidate = trimmed.slice(i);
    let obj: unknown = null;
    try {
      obj = JSON.parse(candidate);
    } catch {
      // not a complete JSON tail — try an earlier "{"
    }
    const tool =
      obj !== null && typeof obj === "object" && !Array.isArray(obj)
        ? (obj as { tool?: unknown }).tool
        : undefined;
    if (
      typeof tool === "string" &&
      (forcedToolName !== undefined
        ? tool === forcedToolName
        : toolNames.has(tool))
    ) {
      const input = (obj as { input?: unknown }).input;
      return {
        text: trimmed.slice(0, i).trimEnd(),
        toolCall: {
          toolName: tool,
          input:
            input !== null && typeof input === "object" && !Array.isArray(input)
              ? input
              : {},
        },
      };
    }
    // NOTE: lastIndexOf treats a negative fromIndex as 0 — guard i === 0
    // explicitly or the loop restarts at 0 forever.
    i = i === 0 ? -1 : trimmed.lastIndexOf("{", i - 1);
  }
  return null;
}

// ─── Live tool-activity display (protocol-2 events → data-phase) ──────────

// The phase name is an existing chat.phase i18n key ("Working…") so the
// indicator needs no message-file changes; the CLI's English summary lines
// ride in `summaries` (same as tool names today — fine for v1).
const BRIDGE_PHASE_NAME = "stageWorking";
const BRIDGE_PHASE_ID = "phase-bridge";
// Mirrors progress-throttle.ts: the server pump drains ~55-60 chunks/sec.
const BRIDGE_EVENT_THROTTLE_MS = 40;
/** Display cap on the structured tool rows (runBridge already caps at 200). */
const BRIDGE_TOOL_ROWS_MAX = 50;
/** Cap on the rolling narration line (oldest chars drop off the front). */
const BRIDGE_LIVE_MAX_CHARS = 300;

/** The `data-phase` payload the bridge activity emitter writes. */
export interface BridgePhaseData {
  phase: string;
  running: boolean;
  /** Accumulated human lines (one per activity, start→ok dups collapsed). */
  summaries: string[];
  /** Structured per-tool rows — the generic bridge-tool indicator's data. */
  tools: BridgeEvent[];
  /**
   * The rolling narration line — the CLI's current thinking/narration text
   * (protocol-2 `{"delta"}` lines, housekeeping phase: the client suppresses
   * the JSON report block, so deltas are display-safe). Only the CURRENT
   * line is kept: the fragment after the last newline seen, capped at
   * BRIDGE_LIVE_MAX_CHARS (tail kept). Absent until the first delta arrives.
   */
  live?: string;
  /**
   * Housekeeping card only: set when the bridge call failed and the turn
   * degraded to the deterministic path — the card shows an amber warning
   * instead of settling silently green. Carries the failure reason.
   */
  warning?: string;
}

export interface BridgeEventEmitter {
  onEvent: (event: BridgeEvent) => void;
  /** Fold a live text delta into the rolling narration line (`data.live`). */
  onDelta: (text: string) => void;
  /**
   * Write the initial running frame immediately, before any CLI output —
   * the "Working…" indicator shows from the moment the call starts, so a
   * silent CLI (no events/deltas) never leaves the wait blank.
   */
  kickoff: () => void;
  /** Final settle (running: false) + lock release. ALWAYS call after the run. */
  finish: () => void;
}

/**
 * Create the emitter that turns protocol-2 bridge events into one live
 * `data-phase` chunk stream (`{ phase, running, summaries, tools, live }`,
 * merged by phase name; the frontend renders it as the bridge-tool
 * indicator).
 *
 * Default (no `write`): chunks go DIRECTLY to the workflow run's writable via
 * a single reused `getWritable()` writer (they cannot ride the model stream —
 * the AI SDK step transform rejects unknown chunk types), throttled at 40ms,
 * lock always released; noop outside a workflow step (unit tests). The writer
 * is acquired LAZILY on every write: a transient lock contention (the
 * WorkflowAgent's own writer holds the stream) only drops that frame — frames
 * are cumulative, so the next successful write carries the full state. With a
 * custom `write` (the housekeeping step), frames ride the caller's own
 * channel instead — `id`/`phase` are then the caller's choice.
 *
 * Silent CLIs (no events, no deltas) produce no frames on their own — the
 * chat path calls `kickoff()` up front so the user still gets a "Working…"
 * indicator for the wait.
 */
export function createBridgeEventEmitter(opts?: {
  id?: string;
  phase?: string;
  write?: (data: BridgePhaseData) => void;
}): BridgeEventEmitter {
  const id = opts?.id ?? BRIDGE_PHASE_ID;
  const phase = opts?.phase ?? BRIDGE_PHASE_NAME;
  let writer: WritableStreamDefaultWriter<UIMessageChunk> | null | undefined;
  const lines: string[] = [];
  const tools: BridgeEvent[] = [];
  /** The current narration line (fragment after the last newline seen). */
  let liveLine = "";
  let wroteAny = false;
  let lastWriteMs = 0;

  const write = (running: boolean) => {
    wroteAny = true;
    const data: BridgePhaseData = {
      phase,
      running,
      summaries: [...lines],
      tools: [...tools],
      ...(liveLine ? { live: liveLine } : {}),
    };
    if (opts?.write) {
      try {
        opts.write(data);
      } catch {
        // display hook — never break the bridge
      }
      return;
    }
    if (!writer) {
      try {
        writer = getWritable<UIMessageChunk>().getWriter();
      } catch {
        // Not inside a workflow step (unit tests), or a transient lock
        // contention with the WorkflowAgent's own writer — drop THIS frame
        // and retry on the next write; frames are cumulative, so no state
        // is lost.
        writer = null;
      }
    }
    if (!writer) return;
    void writer
      .write({
        type: "data-phase" as `data-${string}`,
        id,
        data,
      } as UIMessageChunk)
      .catch(() => {});
  };

  return {
    onEvent(event) {
      const line = event.summary || event.name;
      if (!line) return;
      // The CLI typically emits start → ok with the same summary; collapse
      // consecutive duplicates so each activity shows once.
      if (lines[lines.length - 1] !== line) lines.push(line);
      // Structured rows: a start → ok pair for the same tool+summary updates
      // the existing row's status instead of adding a second row.
      const last = tools[tools.length - 1];
      if (last && last.name === event.name && last.summary === event.summary) {
        last.status = event.status;
      } else if (tools.length < BRIDGE_TOOL_ROWS_MAX) {
        tools.push({ ...event });
      }
      const now = Date.now();
      if (now - lastWriteMs < BRIDGE_EVENT_THROTTLE_MS) return;
      lastWriteMs = now;
      write(true);
    },
    onDelta(text) {
      if (!text) return;
      // Rolling line: the current line is the fragment after the last
      // newline seen; completed lines roll away (the UI shows one line).
      const nl = text.lastIndexOf("\n");
      liveLine = nl >= 0 ? text.slice(nl + 1) : liveLine + text;
      if (liveLine.length > BRIDGE_LIVE_MAX_CHARS) {
        liveLine = liveLine.slice(-BRIDGE_LIVE_MAX_CHARS);
      }
      const now = Date.now();
      if (now - lastWriteMs < BRIDGE_EVENT_THROTTLE_MS) return;
      lastWriteMs = now;
      write(true);
    },
    kickoff() {
      // Unconditional first frame: the indicator spins from the start of the
      // call even if the CLI never emits an event or delta.
      write(true);
    },
    finish() {
      // Nothing ever arrived and no kickoff → no phantom phase. A
      // buffered-but-throttled first event/delta (no frame written yet) or a
      // bare kickoff still settles here.
      if (!wroteAny && lines.length === 0 && !liveLine) return;
      try {
        // Unthrottled final frame: the indicator settles on the full list.
        write(false);
        writer?.releaseLock();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Shared post-processing (doGenerate + doStream) ───────────────────────

interface BridgeParsedOutput {
  text: string;
  toolCall?: { toolCallId: string; toolName: string; input: string };
}

/**
 * Split a successful bridge result into text + optional tool call by parsing
 * the text tool protocol's JSON tail. Throws BridgeModelError("invalid-report")
 * when toolChoice demands a call and the tail is missing — output is never
 * faked.
 */
function splitBridgeReport(
  modelId: string,
  raw: string,
  options: LanguageModelV3CallOptions,
  toolInstruction: string | null,
): BridgeParsedOutput {
  if (!toolInstruction) return { text: raw };
  const fnTools = collectFunctionTools(options);
  const forced =
    options.toolChoice?.type === "tool" ? options.toolChoice.toolName : undefined;
  const required = options.toolChoice?.type === "required" || forced !== undefined;
  const extracted = extractBridgeToolCall(
    raw,
    new Set(fnTools.map((t) => t.name)),
    forced,
  );
  if (extracted) {
    return {
      text: extracted.text,
      toolCall: {
        toolCallId: `bridge-call-${++toolCallCounter}`,
        toolName: extracted.toolCall.toolName,
        input: JSON.stringify(extracted.toolCall.input),
      },
    };
  }
  if (required) {
    const tail = raw.slice(-500);
    throw new BridgeModelError(
      modelId,
      "invalid-report",
      `The bridge CLI did not end its reply with the required ` +
        `{"tool": ..., "input": ...} JSON object` +
        (forced ? ` for tool "${forced}"` : "") +
        `. Tail of its output: ${JSON.stringify(tail)}`,
    );
  }
  // toolChoice "auto" + plain text: honest text answer, no fake call.
  return { text: raw };
}

// ─── The model ────────────────────────────────────────────────────────────

/**
 * Bridge model failure. Carries the structured reason so logs keep the
 * category; the turn workflow's error classifier recognizes it by the stable
 * message prefix (names don't reliably survive the workflow VM boundary) and
 * surfaces it immediately as a model error.
 *
 * The `name` is deliberately "FatalError" with `fatal = true`: the workflow
 * step runtime decides retryability name-based (`FatalError.is`), and bridge
 * CLI failures are deterministic — the binary is missing, broken, or hung —
 * so retrying the step would just respawn the CLI (up to the 10-minute
 * bridge timeout) several times before failing the turn anyway.
 */
export class BridgeModelError extends Error {
  readonly fatal = true;
  readonly reason: BridgeFailureReason;
  constructor(modelId: string, reason: BridgeFailureReason, detail: string) {
    super(`Bridge model "${modelId}" failed (${reason}): ${detail}`);
    this.name = "FatalError";
    this.reason = reason;
  }
}

export class BridgeChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "previously-bridge";
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  static readonly classId = BRIDGE_MODEL_CLASS_ID;

  static [WORKFLOW_SERIALIZE](instance: BridgeChatLanguageModel): {
    modelId: string;
  } {
    return { modelId: instance.modelId };
  }

  static [WORKFLOW_DESERIALIZE](data: {
    modelId: string;
  }): BridgeChatLanguageModel {
    return new BridgeChatLanguageModel(data.modelId);
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const warnings = bridgeCallWarnings(options);
    const { task, context, phase, skills } = promptToBridgePayload(options.prompt);
    const toolInstruction = buildBridgeToolInstruction(options);

    // The model id picks the agent CLI: bridge/<agent> → that agent, pinned
    // for this one spawn via the child env so a selector switch needs no
    // kernel restart. Bare/unknown ids fall back to the env-selected agent.
    const agent = bridgeAgentFromModelId(this.modelId);
    const events = createBridgeEventEmitter();
    // Chat path only: show the "Working…" indicator from the moment the call
    // starts, so a silent CLI (no events/deltas) never leaves a blank wait.
    if (!toolInstruction) events.kickoff();
    const result = await runBridge(
      splitBridgeCommand(getBridgeCommand()),
      JSON.stringify({
        task: toolInstruction ? `${task}\n\n${toolInstruction}` : task,
        context,
        // Tool-protocol calls (sub-agent reports on the kill-switch path) get
        // NO phase — the chat skill doc's output contract ("reply rendered
        // verbatim") contradicts the required {"tool": …} JSON tail; a
        // missing phase makes the client use its generic memory doc. Skills
        // ride with the phase: no phase → no skills.
        ...(toolInstruction ? {} : { phase, skills }),
        protocol: BRIDGE_PROTOCOL_VERSION,
      }),
      getBridgeTimeoutMs(),
      { PREVIOUSLY_BRAIN_AGENT: agent },
      events.onEvent,
      undefined,
      options.abortSignal,
    );
    // Settle the live phase indicator even on failure (spinner must stop).
    events.finish();

    if (result.status !== "ok") {
      // Model errors must propagate — the turn workflow classifies them and
      // surfaces a user-visible explanation. Never fake output.
      throw new BridgeModelError(this.modelId, result.reason, result.error);
    }

    // Text tool protocol: parse the JSON tail back into a real tool call.
    const { text, toolCall } = splitBridgeReport(
      this.modelId,
      result.result,
      options,
      toolInstruction,
    );

    const content: LanguageModelV3Content[] = [];
    if (text) content.push({ type: "text", text });
    if (toolCall) content.push({ type: "tool-call", ...toolCall });
    if (content.length === 0) content.push({ type: "text", text: "" });

    return {
      content,
      finishReason: {
        unified: toolCall ? "tool-calls" : "stop",
        raw: undefined,
      },
      usage: UNKNOWN_USAGE,
      warnings,
    };
  }

  /**
   * Streams the chat answer live when the CLI emits protocol-2 `{"delta"}`
   * lines (claude adapter): each delta becomes a text-delta part as it
   * arrives. The deltas are ADVISORY — at completion the stream reconciles to
   * the envelope `result`, which is the source of truth:
   *   - deltas == result          → just close the text block;
   *   - result extends the deltas → emit the remainder (dropped tail);
   *   - true divergence           → close the advisory block and re-emit the
   *     authoritative result as a fresh block (result wins).
   * When NO deltas arrive (codex/kimi, older client) the full result is
   * replayed as a single delta — today's honest one-shot behavior.
   *
   * Live streaming is only enabled on the plain chat path: when the text tool
   * protocol is active (sub-agent report calls) the reply ends with a machine
   * JSON tail that must never render, so those calls always use the one-shot
   * replay (deltas are not subscribed at all).
   *
   * Live protocol-2 tool events keep flowing to the UI via the event emitter
   * while the run executes. Bridge failures error the stream with
   * BridgeModelError — output is never faked.
   */
  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const warnings = bridgeCallWarnings(options);
    const { task, context, phase, skills } = promptToBridgePayload(options.prompt);
    const toolInstruction = buildBridgeToolInstruction(options);
    const agent = bridgeAgentFromModelId(this.modelId);
    const events = createBridgeEventEmitter();
    const modelId = this.modelId;

    const TEXT_ID = "bridge-text-1";
    const TEXT_ID_RECONCILED = "bridge-text-2";

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings });

        // Chat path only: the "Working…" indicator spins from the start of
        // the call, even when the CLI never emits an event or delta.
        if (toolInstruction === null) events.kickoff();

        let textStarted = false;
        let accumulated = "";
        const onDelta = (delta: string) => {
          if (!delta) return;
          // Advisory cap: deltas are never collected by runBridge; keep the
          // accumulator within the envelope cap so a runaway CLI can't grow
          // it unboundedly. The envelope result is reconciled to regardless.
          if (accumulated.length >= BRIDGE_MAX_RESULT_CHARS_V2) return;
          if (!textStarted) {
            controller.enqueue({ type: "text-start", id: TEXT_ID });
            textStarted = true;
          }
          controller.enqueue({ type: "text-delta", id: TEXT_ID, delta });
          accumulated += delta;
        };

        void (async () => {
          const result = await runBridge(
            splitBridgeCommand(getBridgeCommand()),
            JSON.stringify({
              task: toolInstruction ? `${task}\n\n${toolInstruction}` : task,
              context,
              // No phase on tool-protocol calls — see doGenerate. Skills ride
              // with the phase.
              ...(toolInstruction ? {} : { phase, skills }),
              protocol: BRIDGE_PROTOCOL_VERSION,
            }),
            getBridgeTimeoutMs(),
            { PREVIOUSLY_BRAIN_AGENT: agent },
            events.onEvent,
            // No live deltas for tool-protocol calls — the JSON report tail
            // would render as chat text.
            toolInstruction === null ? onDelta : undefined,
            options.abortSignal,
          );
          // Settle the live phase indicator even on failure.
          events.finish();

          if (result.status !== "ok") {
            controller.error(
              new BridgeModelError(modelId, result.reason, result.error),
            );
            return;
          }

          const { text, toolCall } = splitBridgeReport(
            modelId,
            result.result,
            options,
            toolInstruction,
          );

          // ── Reconcile the advisory deltas with the envelope result ──
          if (textStarted) {
            if (text !== accumulated) {
              if (text.startsWith(accumulated)) {
                // Dropped tail (throttled/lost deltas) — result wins.
                const remainder = text.slice(accumulated.length);
                if (remainder) {
                  controller.enqueue({
                    type: "text-delta",
                    id: TEXT_ID,
                    delta: remainder,
                  });
                }
              } else {
                // True divergence (adapter bug): the streamed text can't be
                // retracted — close it and re-emit the authoritative result
                // as a fresh block (result wins). The providerMetadata marker
                // survives stream → UI-part assembly (unlike the block id) and
                // tells buildStream to REPLACE the advisory text item instead
                // of concatenating the two.
                console.warn(
                  `[BridgeModel] streamed deltas diverge from the envelope ` +
                    `result (model ${modelId}) — the envelope wins.`,
                );
                controller.enqueue({ type: "text-end", id: TEXT_ID });
                textStarted = false;
                if (text) {
                  controller.enqueue({
                    type: "text-start",
                    id: TEXT_ID_RECONCILED,
                    providerMetadata: {
                      "previously-bridge": { authoritative: true },
                    },
                  });
                  controller.enqueue({
                    type: "text-delta",
                    id: TEXT_ID_RECONCILED,
                    delta: text,
                  });
                  controller.enqueue({ type: "text-end", id: TEXT_ID_RECONCILED });
                }
              }
            }
            if (textStarted) {
              controller.enqueue({ type: "text-end", id: TEXT_ID });
            }
          } else if (text || !toolCall) {
            // No deltas (codex/kimi, legacy CLI, tool-protocol call): the
            // honest one-shot replay. An empty text block is still emitted
            // when there is no tool call, matching doGenerate's contract.
            controller.enqueue({ type: "text-start", id: TEXT_ID });
            if (text) {
              controller.enqueue({ type: "text-delta", id: TEXT_ID, delta: text });
            }
            controller.enqueue({ type: "text-end", id: TEXT_ID });
          }

          if (toolCall) {
            controller.enqueue({
              type: "tool-input-start",
              id: toolCall.toolCallId,
              toolName: toolCall.toolName,
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: toolCall.toolCallId,
              delta: toolCall.input,
            });
            controller.enqueue({ type: "tool-input-end", id: toolCall.toolCallId });
            controller.enqueue({ type: "tool-call", ...toolCall });
          }

          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: toolCall ? "tool-calls" : "stop",
              raw: undefined,
            },
            usage: UNKNOWN_USAGE,
          });
          controller.close();
        })().catch((err) => {
          events.finish();
          controller.error(err);
        });
      },
    });

    return { stream };
  }
}

/** Construction point used by createModel() dispatch and workflow deserialization. */
export function createBridgeLanguageModel(modelId: string): LanguageModelV3 {
  return new BridgeChatLanguageModel(modelId);
}
