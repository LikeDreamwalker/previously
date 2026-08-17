/**
 * startTurn — the single entry point that fires a durable chat-turn run.
 *
 * The POST /api/chat route converges here. All the request-scoped derivation
 * that needs real Date / config I/O / message conversion (which the
 * deterministic workflow body must NOT do) lives here, in the route layer: load
 * config, resolve model + thinking, convert messages, extract the last user
 * text, stamp the start time. The result is a fully serializable `TurnInput`
 * passed by value into `start(turnWorkflow, …)`.
 *
 * Returns the run so the route can stream `run.readable` back to the client and
 * expose `run.runId` (the reconnect handle) in a response header.
 */
import { start } from "workflow/api";
import crypto from "crypto";
import { convertToModelMessages, type UIMessage } from "ai";
import { turnWorkflow } from "./turn-workflow";
import type { TurnInput } from "@/lib/chat/turn-types";
import { loadUserConfig } from "@/lib/config/loader";
import {
  getModel,
  getDefaultModelId,
  ALL_MODELS,
  type ModelConfig,
} from "@/lib/models/registry";
import { resolveAvailableModels } from "@/lib/models/catalog";
import { resolveWorkerModel } from "@/lib/models/worker";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";

export interface StartTurnArgs {
  /** Raw UI messages from the client. */
  messages: UIMessage[];
  /** Optional model override; falls back to the user config default. */
  model?: string;
  /** Optional thinking override; only `false` disables the config default. */
  thinking?: boolean;
  /** Optional reasoning effort override. */
  effort?: "low" | "medium" | "high";
  /** Client-reported timezone, used when minting a new slice. */
  timezone?: string;
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale?: string;
}

/** Extract the latest user message text from raw UI messages. */
function extractLastUserText(msg: UIMessage | undefined): string {
  if (!msg) return "";
  const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (Array.isArray(parts)) {
    const textPart = parts.find(
      (p) => p.type === "text" && typeof p.text === "string"
    );
    if (textPart?.text) return textPart.text;
  }
  const content = (msg as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

/**
 * Resolve a model id to its full config so the agent can route to the right
 * provider. models.dev-derived ids (Kimi, Qwen, ...) are NOT in the curated
 * registry, so they're looked up in the dynamic catalog. Unknown ids fall back
 * to the deployment default.
 *
 * Note: legacy ids are NOT remapped here — the config file is already migrated
 * by `mergeConfig`; a client-stored legacy id simply won't match and falls
 * back to the default.
 */
async function resolveModelConfig(id: string): Promise<{
  model: string;
  modelConfig: ModelConfig;
}> {
  const curated = getModel(id);
  if (curated) return { model: curated.id, modelConfig: curated };

  const available = await resolveAvailableModels();
  const found = available.find((m) => m.id === id);
  if (found) return { model: found.id, modelConfig: found };

  const fallbackId = getDefaultModelId();
  const fallback = getModel(fallbackId) ?? available[0] ?? ALL_MODELS[0];
  return { model: fallback.id, modelConfig: fallback };
}

export async function startTurn(
  args: StartTurnArgs
): Promise<Awaited<ReturnType<typeof start>>> {
  const config = await loadUserConfig();
  // Resolve the model id (client override → config default, already migrated
  // by mergeConfig) to a full ModelConfig, falling back to the deployment
  // default when the id is unknown/unavailable.
  const requested = args.model || config.model.provider;
  const { model, modelConfig } = await resolveModelConfig(requested);
  // The worker tier for housekeeping-class calls (tag extraction, marking,
  // recall, loops) — derived from the main model, see src/lib/models/worker.ts.
  const workerModel = await resolveWorkerModel(modelConfig);
  // The client's explicit thinking value wins when sent (it always reflects
  // what the selector shows / the model's default); the config value is only
  // a fallback for clients that don't send one. This keeps the client's UI in
  // sync with the actual call.
  const thinking = args.thinking ?? config.model.thinking;
  const reasoningEffort = args.effort ?? config.model.reasoningEffort;
  // Log the resolved model so a switch is verifiable in the server log.
  // `requested` = what the client sent; `model` = what actually runs.
  console.log(
    `[Turn] model=${model} (requested=${requested}) sdk=${modelConfig.sdk} thinking=${thinking} effort=${reasoningEffort}`,
  );
  const clientTimezone = args.timezone ?? "UTC";
  // UI locale for relative-time annotations — only zh/en are supported; any
  // other value (or none) falls back to English.
  const locale = args.locale === "zh" ? "zh" : "en";
  const { owner, repo } = getRepoConfig();
  const dataSource = resolveDataSource();

  // Generate turn identity early — shared by user turn, agent turn, and
  // agent.md cognition record. 4 random bytes → 6-char base64url, unique
  // within a slice (and collision probability across 2^32 ≈ 4.3B values is
  // negligible for a time slice's lifetime).
  const turnId = crypto.randomBytes(4).toString("base64url");

  // Only send recent messages to the model; older context is retrieved on
  // demand via recall. The 1.2× multiplier gives a small buffer beyond the
  // configured limit so short back-and-forth exchanges stay intact.
  const recentLimit = Math.ceil(config.context.recentTurnsLimit * 1.2);
  const fullMessages = await convertToModelMessages(args.messages);
  const modelMessages = fullMessages.slice(-recentLimit);
  const recentTurns = modelMessages.map((m) => ({
    role: m.role as string,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  const userMessages = args.messages.filter((m) => m.role === "user");
  const lastUserMessage = extractLastUserText(userMessages[userMessages.length - 1]);

  const input: TurnInput = {
    modelMessages,
    recentTurns,
    lastUserMessage,
    model,
    modelConfig,
    workerModel,
    thinking,
    reasoningEffort,
    clientTimezone,
    locale,
    config,
    owner,
    repo,
    useGithub: dataSource === "github",
    useDemo: dataSource === "demo",
    startedAtIso: new Date().toISOString(),
    turnId,
  };

  const run = await start(turnWorkflow, [input]);

  // TODO(v0.6): client-side reconnection — persist the runId → return here to
  // the client's localStorage alongside the runId WorkflowChatTransport already
  // stores. When a dropped stream reconnects, the client replays from the last
  // seen index and derives the terminal turn status from the final assistant
  // message. The run→turn mapping lives on the client, not on disk.

  return run;
}
