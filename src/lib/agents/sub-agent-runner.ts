/**
 * Sub-agent runner — the shared skeleton every internal sub-agent runs on
 * (v0.9 unified sub-agent architecture, extracted from thinkDeep in
 * src/app/api/agent/tool-executors.ts).
 *
 * One `runSubAgent` call = one bounded model invocation:
 *   - model:      the caller passes a resolved ModelConfig; tool executors can
 *                 resolve the turn's main model via `resolveSubAgentModel(ctx)`
 *                 (`ctx.mainModel ?? resolveMainModelFromConfig()`).
 *   - thinking:   always ON via `normalizeReasoningEffort(sdk, id, true, effort)`
 *                 (effort defaults to "low"); provider quirks (DeepSeek explicit
 *                 low, Anthropic budgets) are inherited from the effort injector.
 *   - streaming:  `streamText` (not generateText) so `onChunk` captures BOTH
 *                 channels progressively — the reasoning trail (stage
 *                 "thinking") and the answer text (stage "writing") stream LIVE
 *                 as the current line (text after the last newline), and the
 *                 accumulated partial survives a mid-thought timeout abort.
 *                 Lines go to the `data-tool-progress` emitter when a
 *                 `toolCallId` exists, and to the optional `onLine` callback
 *                 for callers outside a tool call (e.g. the Previously Agent
 *                 inside housekeeping) — whichever is wired, both if both are.
 *   - progress:   optional streaming of stage lines onto the shared
 *                 `data-tool-progress` channel (throttled, single reused writer,
 *                 lock released on settle). Degrades to a noop when there is no
 *                 `toolCallId` or no workflow step writable.
 *   - timeout:    the SDK's `timeout` option is the PRIMARY hook (it runs
 *                 `AbortSignal.timeout()` in real Node and aborts cleanly);
 *                 `withStepTimeout` is the backstop so a step NEVER dies
 *                 silently. Timeouts return a structured partial result
 *                 (`timedOut: true`) instead of throwing.
 *   - steps:      `stopWhen: isStepCount(maxSteps)` when a cap is given.
 *   - output:     the report-tool pattern — the model reports through a
 *                 designated tool whose input is zod-validated into `report`.
 *   - hooks:      optional `prepareStep` passthrough (e.g. recall forcing its
 *                 report tool on the final step) and `onToolProgress`, which
 *                 turns each sub-agent tool start into a progress line on the
 *                 run's own emitter.
 *
 * Providers that need custom construction (flash-search's DeepSeek
 * Anthropic-compatible endpoint with its response-normalizing fetch) pass a
 * pre-built `languageModel` instead of a ModelConfig; `effortSdk` then picks
 * the SDK family used for the effort mapping.
 *
 * There is deliberately NO `maxOutputTokens` here (project-wide ban): a hard
 * token cap is invisible to the model and silently truncates the report.
 * The runner never throws — every failure is a structured `{ ok: false }`.
 */
import {
  isStepCount,
  streamText,
  type LanguageModel,
  type PrepareStepFunction,
  type ToolSet,
} from "ai";
import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import type { z } from "zod";
import { createModel } from "@/lib/models/provider";
import { normalizeReasoningEffort } from "@/lib/models/effort-injector";
import { resolveMainModelFromConfig } from "@/lib/models/resolve";
import type { ModelConfig } from "@/lib/models/registry";
import type { ProviderSdk } from "@/lib/models/providers";
import { withStepTimeout } from "@/lib/chat/step-timeout";
import {
  shouldEmitProgress,
  type ProgressLine,
  type ProgressWriteState,
  type ToolProgressStage,
} from "@/lib/chat/progress-throttle";

// ─── Model resolution ──────────────────────────────────────────────────────

/**
 * Resolve the model for a sub-agent from a tool context: the turn's main
 * model when it flowed through the context (shared construction with the main
 * agent — no per-call config resolution), otherwise resolved from user config.
 */
export async function resolveSubAgentModel(ctx?: {
  mainModel?: ModelConfig;
}): Promise<ModelConfig> {
  return ctx?.mainModel ?? (await resolveMainModelFromConfig());
}

// ─── Streaming progress ────────────────────────────────────────────────────

/** Where a sub-agent's progress lines go. No `toolCallId` → fully noop. */
export interface SubAgentProgressRef {
  /** Present only when the sub-agent runs as a tool inside a workflow step. */
  toolCallId?: string;
  /** Tool name carried in the progress chunk data. */
  toolName: string;
}

export interface ProgressEmitter {
  /** Emit the current single line (throttled; latest line wins on the client). */
  emit(line: string, stage: ToolProgressStage): void;
  /** Flush the final line and release the writer lock. ALWAYS call on settle. */
  close(finalLine?: string, stage?: ToolProgressStage): void;
}

/**
 * Create a throttled `data-tool-progress` emitter for one sub-agent run.
 * Mirrors thinkDeep's discipline: a single reused `getWritable()` writer (a
 * fresh pipeline per write failed silently on long runs), throttled via
 * `shouldEmitProgress` (the server pump drains ~55-60 chunks/sec — writing
 * every token backs up a queue that drains after the turn renders), and the
 * lock always released so the step's HTTP request can terminate. The client
 * merges chunks by (type, id = `tool-<toolCallId>`) into one part, so the
 * write cadence here is decoupled from delivery.
 *
 * Degrades to a noop when there is no toolCallId (not a tool call) or when
 * `getWritable()` throws (not inside a workflow step — e.g. unit tests).
 */
export function createProgressEmitter(
  ref?: SubAgentProgressRef,
): ProgressEmitter {
  const noop: ProgressEmitter = { emit() {}, close() {} };
  if (!ref?.toolCallId) return noop;
  const { toolCallId, toolName } = ref;

  let writer: WritableStreamDefaultWriter<UIMessageChunk> | null | undefined;
  let state: ProgressWriteState = {
    lastWriteMs: 0,
    lastLine: "",
    lastStage: undefined,
    sentAny: false,
  };

  const send = (line: string, stage: ToolProgressStage) => {
    if (writer === undefined) {
      try {
        writer = getWritable<UIMessageChunk>().getWriter();
      } catch {
        writer = null; // not inside a workflow step — stay noop
      }
    }
    if (!writer) return;
    void writer
      .write({
        type: "data-tool-progress",
        id: `tool-${toolCallId}`,
        data: { toolCallId, toolName, text: line, stage },
      })
      .catch(() => {});
  };

  return {
    emit(line, stage) {
      if (!line) return;
      const now = Date.now();
      if (!shouldEmitProgress(state, { line, stage }, now)) return;
      state = { lastWriteMs: now, lastLine: line, lastStage: stage, sentAny: true };
      send(line, stage);
    },
    close(finalLine, stage = "done") {
      try {
        // Push the final line so the box settles on it (the last throttled
        // write may have been a few lines behind).
        if (finalLine && (finalLine !== state.lastLine || stage !== state.lastStage)) {
          send(finalLine, stage);
        }
        writer?.releaseLock();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Report extraction ─────────────────────────────────────────────────────

/**
 * Extract a sub-agent's structured report: find the designated report tool
 * call in the stream's final tool calls and zod-validate its input. Returns undefined
 * when the tool was never called or the input fails validation — the caller
 * then applies its own degradation (empty analysis, no merges, …).
 */
export function extractToolReport<S extends z.ZodType>(
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> | undefined,
  reportToolName: string,
  reportSchema: S,
): z.infer<S> | undefined {
  const call = toolCalls?.find((tc) => tc.toolName === reportToolName);
  if (!call || call.input === undefined || call.input === null) return undefined;
  const parsed = reportSchema.safeParse(call.input);
  return parsed.success ? parsed.data : undefined;
}

// ─── Runner ────────────────────────────────────────────────────────────────

/** Detect the SDK `timeout` abort — `AbortSignal.timeout()` surfaces as "AbortError". */
function isTimeoutAbort(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

export interface RunSubAgentOptions<Report> {
  /**
   * The resolved model to run on (see resolveSubAgentModel). Omit only when
   * `languageModel` carries a pre-built instance.
   */
  model?: ModelConfig;
  /**
   * Pre-built model instance — bypasses `createModel(model)` when the provider
   * needs custom construction (e.g. flash-search's DeepSeek Anthropic-
   * compatible endpoint with its response-normalizing fetch).
   */
  languageModel?: LanguageModel;
  /**
   * SDK family for the effort mapping when `languageModel` bypasses
   * `model.sdk` (the provider behind a pre-built model may speak a different
   * protocol than the model's native SDK family).
   */
  effortSdk?: ProviderSdk;
  /** Static system prompt — build with `buildSubAgentSystem(role)` from
   * ./prompts so every call shares the same prefix (prompt-cache hits).
   * Everything per-call (task data, current time, signals) goes in `prompt`.
   */
  system?: string;
  /** The dynamic user prompt: task data, current time, signals. */
  prompt: string;
  /** Tool set — at minimum the report tool the agent reports through. */
  tools: ToolSet;
  /** Tool choice — the report-only agents pass "required". Default "auto". */
  toolChoice?: "auto" | "required" | "none";
  /** Name of the report tool whose input is extracted + validated. */
  reportToolName?: string;
  /** Zod schema the report tool's input is validated against. */
  reportSchema?: z.ZodType<Report>;
  /** Hard step cap (`stopWhen: isStepCount(maxSteps)`). Uncapped when omitted. */
  maxSteps?: number;
  /** Per-step override passthrough (AI SDK native) — e.g. recall forcing the
   *  report tool when the step budget is nearly exhausted. */
  prepareStep?: PrepareStepFunction<ToolSet>;
  /**
   * Map each sub-agent tool start to a progress line, streamed live on the
   * run's `data-tool-progress` emitter. Return undefined to skip a tool.
   */
  onToolProgress?: (toolCall: {
    toolName: string;
    input: unknown;
  }) => ProgressLine | undefined;
  /** Wall-clock budget in ms (SDK timeout hook + withStepTimeout backstop). */
  timeoutMs?: number;
  /** Reasoning effort — thinking is always ON. Default "low". */
  effort?: "low" | "medium" | "high";
  /** Sampling temperature. Default 0.1 (structured metadata, not prose). */
  temperature?: number;
  /** Optional progress streaming (noop without a toolCallId). */
  progress?: SubAgentProgressRef;
  /** Stage line emitted at run start (when progress is live). */
  startLine?: string;
  /**
   * Direct live-line callback for callers that do NOT run as a tool call (no
   * `toolCallId` — e.g. the Previously Agent inside housekeeping, which wires
   * this onto the `data-evolution` channel). Receives the CURRENT line (text
   * after the last newline) on every delta, UNTHROTTLED — the caller owns
   * throttling. Coexists with the `progress` emitter: whichever is wired gets
   * the lines, both if both are.
   */
  onLine?: (line: string, stage: "thinking" | "writing") => void;
}

export interface SubAgentResult<Report> {
  /** The model call completed (report may still be absent — check `report`). */
  ok: boolean;
  /** The validated report-tool input, when the model reported and it parsed. */
  report?: Report;
  /** Any generated text (usually empty for report-tool agents). */
  text: string;
  /** The thinking trail, when the provider returned one. */
  reasoning?: string;
  /** Citation sources gathered across steps (provider-executed search tools). */
  sources?: Array<{ sourceType: string; url?: string; title?: string }>;
  /** True when the run hit its wall-clock budget (ok is false). */
  timedOut?: boolean;
  /** Human-readable failure reason (ok is false). */
  error?: string;
}

/** Backstop grace after the SDK timeout hook should have fired. */
const BACKSTOP_GRACE_MS = 3_000;
/** Default wall-clock budget for the cheap structured sub-agents. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run one bounded sub-agent invocation. NEVER throws: timeouts and errors
 * return structured `{ ok: false, timedOut?, error }` results so the caller's
 * degradation path (empty analysis / no merges / skip) stays in control.
 */
export async function runSubAgent<Report = unknown>(
  opts: RunSubAgentOptions<Report>,
): Promise<SubAgentResult<Report>> {
  const {
    model,
    languageModel,
    effortSdk,
    system,
    prompt,
    tools,
    toolChoice = "auto",
    reportToolName,
    reportSchema,
    maxSteps,
    prepareStep,
    onToolProgress,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    effort = "low",
    temperature = 0.1,
    progress,
    startLine,
    onLine,
  } = opts;

  if (!model && !languageModel) {
    return {
      ok: false,
      text: "",
      error: "runSubAgent requires a `model` or a pre-built `languageModel`.",
    };
  }

  const emitter = createProgressEmitter(progress);
  if (startLine) emitter.emit(startLine, "running");

  // Thinking is always requested; the injector owns provider-specific mapping.
  const providerOptions = normalizeReasoningEffort(
    effortSdk ?? model?.sdk,
    model?.id ?? "prebuilt",
    true,
    effort,
  );

  // Accumulated by onChunk — the written answer (text-delta) and the thinking
  // trail (reasoning-delta). Both are returned on completion AND interruption
  // (thinkDeep's partial semantics: a timeout keeps whatever was streamed).
  let text = "";
  let reasoning = "";

  // Live progress: forward the CURRENT line (text after the last newline) so
  // the client shows a growing single line that resets at line boundaries.
  // The emitter throttles internally; `onLine` is the raw per-delta callback
  // for non-tool callers, which own their own throttling.
  const pushLine = () => {
    const source = text || reasoning;
    if (!source) return;
    const line = source.slice(source.lastIndexOf("\n") + 1);
    const stage: "thinking" | "writing" = text ? "writing" : "thinking";
    emitter.emit(line, stage);
    onLine?.(line, stage);
  };

  /** The final stream promises, unwrapped into one plain result object. */
  interface StreamFinal {
    text: string;
    toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
    reasoningText: string | undefined;
    sources: Array<{ sourceType: string; url?: string; title?: string }>;
  }

  const run = async (): Promise<StreamFinal> => {
    // streamText (not generateText) so onChunk captures BOTH channels
    // progressively — never lost, even mid-thought.
    const stream = await streamText({
      model: languageModel ?? createModel(model!),
      system,
      prompt,
      tools,
      toolChoice,
      temperature,
      providerOptions,
      ...(maxSteps !== undefined ? { stopWhen: isStepCount(maxSteps) } : {}),
      ...(prepareStep ? { prepareStep } : {}),
      ...(onToolProgress
        ? {
            onToolExecutionStart: ({ toolCall }) => {
              const line = onToolProgress({
                toolName: toolCall.toolName,
                input: toolCall.input,
              });
              if (line?.line) emitter.emit(line.line, line.stage);
            },
          }
        : {}),
      // The SDK timeout hook — PRIMARY: aborts the stream cleanly at the
      // deadline (AbortSignal.timeout), surfacing as AbortError.
      timeout: timeoutMs,
      onChunk({ chunk }) {
        if (chunk.type === "text-delta") {
          text += chunk.text;
          pushLine();
        } else if (chunk.type === "reasoning-delta") {
          reasoning += chunk.text;
          pushLine();
        }
      },
    });
    // Provider warnings (unsupported settings, silent downgrades) never throw —
    // log them so a quiet degradation is visible in the server log.
    void Promise.resolve(stream.warnings)
      .then((w) => {
        if (w?.length) {
          console.warn(
            `[sub-agent] model=${model?.id ?? "prebuilt"} stream warnings:`,
            w,
          );
        }
      })
      .catch(() => {});
    const [finalText, toolCalls, reasoningText, sources] = await Promise.all([
      stream.text,
      stream.toolCalls,
      stream.reasoningText,
      stream.sources,
    ]);
    return {
      text: finalText ?? "",
      toolCalls,
      reasoningText: reasoningText ?? undefined,
      sources: (sources ?? []) as StreamFinal["sources"],
    };
  };

  try {
    // withStepTimeout — BACKSTOP: if the SDK abort somehow doesn't surface,
    // the step still returns a structured result before the platform wall.
    const res = await withStepTimeout(run, timeoutMs + BACKSTOP_GRACE_MS);
    if (!res.ok) {
      // Backstop fired — return whatever was accumulated before the cutoff.
      return {
        ok: false,
        timedOut: true,
        text,
        ...(reasoning ? { reasoning } : {}),
        error: `Sub-agent did not finish within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    const result = res.result!;
    const report =
      reportToolName && reportSchema
        ? extractToolReport(result.toolCalls, reportToolName, reportSchema)
        : undefined;
    return {
      ok: true,
      report,
      text: result.text,
      reasoning: result.reasoningText,
      ...(result.sources.length
        ? { sources: result.sources as SubAgentResult<Report>["sources"] }
        : {}),
    };
  } catch (err) {
    if (isTimeoutAbort(err)) {
      // The SDK timeout hook aborted the stream — return the partial content
      // accumulated before the abort (thinkDeep partial semantics).
      return {
        ok: false,
        timedOut: true,
        text,
        ...(reasoning ? { reasoning } : {}),
        error: `Sub-agent did not finish within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    return {
      ok: false,
      text: "",
      error: err instanceof Error ? err.message : "Sub-agent failed",
    };
  } finally {
    // Push the final line so the progress box settles on the real last line
    // (the last throttled write may have been a few lines behind), then
    // release the writer lock so the step's HTTP request can terminate.
    const source = text || reasoning;
    if (source) {
      emitter.close(
        source.slice(source.lastIndexOf("\n") + 1),
        text ? "writing" : "thinking",
      );
    } else {
      emitter.close();
    }
  }
}
