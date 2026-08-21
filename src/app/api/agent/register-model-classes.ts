/**
 * Model-class serialization registration for the STEP runtime.
 *
 * WorkflowAgent serializes its LanguageModel instance across the
 * workflow→step boundary (into `doStreamStep`). Two problems with the stock
 * setup, both fixed here:
 *
 * 1. The withWorkflow compiler inlines the class registration for
 *    `DeepSeekChatLanguageModel` into the workflow (flow) bundle only, so the
 *    step route can't deserialize the model at all ("Class … not found").
 * 2. Even with the class registered, @ai-sdk/deepseek's own
 *    `WORKFLOW_DESERIALIZE` re-news the class with the serialized config —
 *    which necessarily dropped the non-serializable `url`/`fetch` functions
 *    (`serializeModelOptions` keeps JSON-safe values only), so the first
 *    request dies with "this.config.url is not a function".
 *
 * So instead of the broken stock deserializer we register a host whose
 * deserializer REBUILDS the model through the `deepseek()` factory: the
 * serialized payload's `modelId` is all it needs, and the factory restores a
 * complete config (baseURL, auth headers from DEEPSEEK_API_KEY, url/fetch)
 * from the step runtime's environment.
 *
 * Imported for its side effect from ./tool-executors.ts, which the loader
 * compiles into the step bundle — so registration runs on every step-route
 * cold start before any doStreamStep message is handled.
 *
 * The classId format is fixed by the compiler: `class//<pkg>@<version>//<ClassName>`.
 * The version comes from the installed package.json, so upgrades stay in sync.
 */
import { registerSerializationClass } from "workflow/internal/class-serialization";
import { deepseek } from "@ai-sdk/deepseek";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { BridgeChatLanguageModel } from "@/lib/models/bridge-model";
import deepseekPkg from "@ai-sdk/deepseek/package.json";
import anthropicPkg from "@ai-sdk/anthropic/package.json";
import openaiPkg from "@ai-sdk/openai/package.json";

// Global-registry symbol shared with @workflow/serde (Symbol.for — safe to
// recreate here without importing the transitive package).
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

interface SerializedModelOptions {
  modelId: string;
  config: Record<string, unknown>;
}

// The registry only requires a Function carrying the deserialize symbol; the
// name is cosmetic. All DeepSeek V4 model ids share this class.
function DeepSeekChatLanguageModelHost(): void {}
(
  DeepSeekChatLanguageModelHost as unknown as Record<symbol, unknown>
)[WORKFLOW_DESERIALIZE] = (options: SerializedModelOptions) =>
  deepseek(options.modelId);

registerSerializationClass(
  `class//@ai-sdk/deepseek@${deepseekPkg.version}//DeepSeekChatLanguageModel`,
  DeepSeekChatLanguageModelHost
);

// Anthropic — same rebuild-through-factory pattern, keyed on the SDK's actual
// class name (AnthropicLanguageModel). createAnthropic({}) restores the
// complete config (baseURL, auth headers from ANTHROPIC_API_KEY, url/fetch)
// from the step runtime's environment.
function AnthropicLanguageModelHost(): void {}
(
  AnthropicLanguageModelHost as unknown as Record<symbol, unknown>
)[WORKFLOW_DESERIALIZE] = (options: SerializedModelOptions) =>
  createAnthropic({})(options.modelId);

registerSerializationClass(
  `class//@ai-sdk/anthropic@${anthropicPkg.version}//AnthropicLanguageModel`,
  AnthropicLanguageModelHost
);

// OpenAI / OpenAI-compatible (Kimi, Qwen, ...) — same rebuild-through-factory
// pattern. Unlike deepseek/anthropic, there is no single global env var or
// baseURL for the catch-all provider, so the deserializer reads them back from
// the serialized config (baseURL + apiKey are JSON-safe; only url/fetch are
// dropped). When absent it degrades to a bare openai provider rather than
// crashing with "Class not found".
function rebuildOpenAIModel(options: SerializedModelOptions) {
  const cfg = (options.config ?? {}) as Record<string, unknown>;
  return createOpenAI({
    ...(typeof cfg.baseURL === "string" && cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    ...(typeof cfg.apiKey === "string" && cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  })(options.modelId);
}

function OpenAIChatLanguageModelHost(): void {}
(
  OpenAIChatLanguageModelHost as unknown as Record<symbol, unknown>
)[WORKFLOW_DESERIALIZE] = rebuildOpenAIModel;

registerSerializationClass(
  `class//@ai-sdk/openai@${openaiPkg.version}//OpenAIChatLanguageModel`,
  OpenAIChatLanguageModelHost
);

// The default `provider(modelId)` may instantiate the Responses API model —
// register that class name too so either default deserializes.
function OpenAIResponsesLanguageModelHost(): void {}
(
  OpenAIResponsesLanguageModelHost as unknown as Record<symbol, unknown>
)[WORKFLOW_DESERIALIZE] = rebuildOpenAIModel;

registerSerializationClass(
  `class//@ai-sdk/openai@${openaiPkg.version}//OpenAIResponsesLanguageModel`,
  OpenAIResponsesLanguageModelHost
);

// Bridge (local subscription CLI, client mode + PREVIOUSLY_BRAIN=bridge) —
// our own class, so we register it directly: it carries its own static
// classId + WORKFLOW_DESERIALIZE (see src/lib/models/bridge-model.ts), and
// the deserializer just re-news it from the serialized modelId. The bridge
// command/timeout are read from the step runtime's env at call time.
registerSerializationClass(
  BridgeChatLanguageModel.classId,
  BridgeChatLanguageModel as unknown as Parameters<
    typeof registerSerializationClass
  >[1]
);
