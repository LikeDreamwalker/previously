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
 * is the generated text. This is honestly NON-streaming: doStream waits for
 * the full result and emits it as a single text delta.
 *
 * Limitations (by design, not silently hidden):
 *   - No structured tool calls. The bridge CLI returns text only, so the chat
 *     agent is constructed WITHOUT kernel tools when this model is selected
 *     (see createChatAgent in src/app/api/agent/agent.ts), and the system
 *     prompt says so (see turn-workflow.ts). Memory reads still work on the
 *     bridge side: the client spawns the CLI in a per-call skills workspace
 *     whose instruction files (CLAUDE.md / AGENTS.md) explain how to read
 *     Previously's read-only markdown memory — the client repo's setup, not
 *     ours.
 *   - No token usage accounting — usage fields are reported as undefined.
 *   - Bridge failures (missing binary, non-zero exit, timeout, empty output)
 *     THROW as model errors so the turn workflow surfaces them honestly;
 *     output is never faked (design doc/design/v0.9-client.md §8).
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
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import {
  getBridgeCommand,
  getBridgeTimeoutMs,
  runBridge,
  splitBridgeCommand,
  type BridgeFailureReason,
} from "@/lib/bridge";
import { bridgeAgentFromModelId } from "./registry";

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
 */
export function promptToBridgePayload(prompt: LanguageModelV3Prompt): {
  task: string;
  context: string | null;
} {
  const transcript = prompt.map(renderMessage);
  const last = prompt[prompt.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    const task = last.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n")
      .trim();
    if (task) {
      const context = transcript.slice(0, -1).join("\n\n");
      return { task, context: context || null };
    }
  }
  return { task: transcript.join("\n\n"), context: null };
}

/** Warnings for call options the bridge cannot honor. */
export function bridgeCallWarnings(
  options: LanguageModelV3CallOptions,
): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  if (options.tools && options.tools.length > 0) {
    // Shouldn't happen — the chat agent is built without tools for this
    // model — but if a caller passes tools anyway, say so honestly instead
    // of silently dropping them.
    warnings.push({
      type: "unsupported",
      feature: "tools",
      details:
        "The subscription bridge returns plain text and cannot emit " +
        "structured tool calls; the tools were NOT exposed to the model.",
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
    const { task, context } = promptToBridgePayload(options.prompt);

    // The model id picks the agent CLI: bridge/<agent> → that agent, pinned
    // for this one spawn via the child env so a selector switch needs no
    // kernel restart. Bare/unknown ids fall back to the env-selected agent.
    const agent = bridgeAgentFromModelId(this.modelId);
    const result = await runBridge(
      splitBridgeCommand(getBridgeCommand()),
      JSON.stringify({ task, context }),
      getBridgeTimeoutMs(),
      { PREVIOUSLY_BRAIN_AGENT: agent },
    );

    if (result.status !== "ok") {
      // Model errors must propagate — the turn workflow classifies them and
      // surfaces a user-visible explanation. Never fake output.
      throw new BridgeModelError(this.modelId, result.reason, result.error);
    }

    return {
      content: [{ type: "text", text: result.result }],
      finishReason: { unified: "stop", raw: undefined },
      usage: UNKNOWN_USAGE,
      warnings,
    };
  }

  /**
   * The bridge is a one-shot subprocess — there is no token stream to
   * forward. doStream runs the full generation, then replays it as a single
   * text delta so the chat UI behaves exactly as with any other model.
   */
  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const result = await this.doGenerate(options);
    const text = result.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const textId = "bridge-text-1";
        controller.enqueue({
          type: "stream-start",
          warnings: result.warnings,
        });
        controller.enqueue({ type: "text-start", id: textId });
        if (text) {
          controller.enqueue({ type: "text-delta", id: textId, delta: text });
        }
        controller.enqueue({ type: "text-end", id: textId });
        controller.enqueue({
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
        });
        controller.close();
      },
    });

    return { stream };
  }
}

/** Construction point used by createModel() dispatch and workflow deserialization. */
export function createBridgeLanguageModel(modelId: string): LanguageModelV3 {
  return new BridgeChatLanguageModel(modelId);
}
