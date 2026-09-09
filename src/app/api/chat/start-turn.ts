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
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { demoModelLock } from "@/lib/demo/model-lock";

export interface StartTurnArgs {
  /** Raw UI messages from the client. */
  messages: UIMessage[];
  /** Optional model override; falls back to the user config default. */
  model?: string;
  /** Ignored — thinking is pinned ON server-side (see below). */
  thinking?: boolean;
  /** Ignored — effort is pinned to "low" server-side (see below). */
  effort?: "low" | "medium" | "high";
  /** Client-reported timezone, used when minting a new slice. */
  timezone?: string;
  /** UI locale ("zh" | "en") — relative-time annotations follow it. */
  locale?: string;
  /** True on the client regenerate action (SDK trigger "regenerate-message") —
   *  the turn re-runs the previous user message; see TurnInput.regenerate. */
  regenerate?: boolean;
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

/** Max image attachments extracted per turn when the main model lacks vision. */
const MAX_IMAGE_ATTACHMENTS = 4;

/**
 * For non-vision main models: extract image file parts into a per-turn
 * attachments array and replace each stripped image with a text placeholder
 * telling the model to call `viewImage`. Non-image file parts are dropped.
 *
 * The data URLs ride the workflow step boundary via ToolContext.imageAttachments,
 * so viewImage can resolve `attachment:N`. They are capped to keep the payload
 * bounded (client-side 1568px compression + a 4-image count cap).
 */
export function extractImageAttachments(
  messages: UIMessage[],
  locale: string,
): { messages: UIMessage[]; attachments: string[] } {
  const attachments: string[] = [];
  const placeholder = (idx: number) =>
    locale === "zh"
      ? `[用户附带了一张图片（附件 #${idx}）。你当前无法直接查看图片——调用 viewImage，source 填 "attachment:${idx}"，question 描述你想知道什么。]`
      : `[The user attached an image (attachment #${idx}). You cannot see it directly right now — call viewImage with source "attachment:${idx}" and use question to say what you want to know.]`;

  const out = messages
    .map((m) => {
      if (m.role !== "user" || attachments.length >= MAX_IMAGE_ATTACHMENTS) {
        return m;
      }
      const newParts: UIMessage["parts"] = [];
      for (const p of m.parts ?? []) {
        if (p.type !== "file") {
          newParts.push(p);
          continue;
        }
        const mediaType = (p as { mediaType?: string }).mediaType ?? "";
        const url = (p as { url?: string }).url ?? "";
        if (
          !mediaType.startsWith("image/") ||
          attachments.length >= MAX_IMAGE_ATTACHMENTS ||
          !url
        ) {
          // Drop non-image files and excess/unloadable images.
          continue;
        }
        const idx = attachments.length;
        attachments.push(url);
        newParts.push({ type: "text", text: placeholder(idx) });
      }
      return { ...m, parts: newParts };
    })
    .filter((m) => (m.parts ?? []).length > 0);

  return { messages: out, attachments };
}

/**
 * Summarize a converted ModelMessage's content as plain text for recentTurns.
 * NEVER JSON.stringify array content here: file/image parts carry base64 data
 * URLs, which would embed megabytes into the prompt context. Text parts keep
 * their text; file parts become [image]/[file]; everything else (tool-call,
 * tool-result, …) collapses to a short [type] placeholder.
 */
export function summarizeModelContent(
  content: unknown,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string; mediaType?: string };
      if (p.type === "text") return p.text ?? "";
      if (p.type === "file" || p.type === "image") {
        return p.mediaType?.startsWith("image/") ? "[image]" : "[file]";
      }
      return `[${p.type ?? "part"}]`;
    })
    .join("\n");
}

export async function startTurn(
  args: StartTurnArgs
): Promise<Awaited<ReturnType<typeof start>>> {
  const config = await loadUserConfig();
  // Demo mode: model + thinking intensity are pinned server-side (the demo
  // runs on the maintainer's key) — client/config preferences are ignored.
  const lock = demoModelLock();
  // Resolve the model id (demo lock → client override → config default, already
  // migrated by mergeConfig) to a full ModelConfig, falling back to the
  // deployment default when the id is unknown/unavailable.
  const requested = lock?.model ?? (args.model || config.model.provider);
  const { model, modelConfig } = await resolveModelConfig(requested);
  // Thinking is pinned ON at LOW effort for every turn — fast responses are the
  // product rule; deep thinking is thinkDeep's job (it keeps its own
  // model-chosen effort). Client-sent thinking/effort and the stored config
  // values are IGNORED. The demo lock wins when active (it pins its own
  // model/thinking/effort for the maintainer's-key demo). Thinking follows the
  // model's capability — a non-thinking model (bridge, non-reasoning catalog
  // entries) stays off.
  const thinking = lock?.thinking ?? modelConfig.capabilities.thinking;
  const reasoningEffort = lock?.effort ?? "low";
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

  // The full client history goes to the WORKFLOW — the slice-aligned window
  // is cut there (sliceAlignedWindow in turn-workflow.ts, v0.9 Phase 1.4).
  // This is only a broad payload cap guarding against a misbehaving client.
  const MAX_HISTORY_MESSAGES = 200;
  let inbound = args.messages;
  let imageAttachments: string[] = [];
  if (!modelConfig.capabilities.vision) {
    const hasImageFiles = args.messages.some((m) =>
      (m.parts ?? []).some(
        (p) => p.type === "file" && (p as { mediaType?: string }).mediaType?.startsWith("image/"),
      ),
    );
    if (hasImageFiles) {
      console.warn(`[Turn] model=${model} has no vision — extracting image attachments`);
      const extracted = extractImageAttachments(args.messages, locale);
      inbound = extracted.messages;
      imageAttachments = extracted.attachments;
    }
  }
  const fullMessages = await convertToModelMessages(inbound);
  const modelMessages = fullMessages.slice(-MAX_HISTORY_MESSAGES);
  const recentTurns = modelMessages.map((m) => ({
    role: m.role as string,
    // Array content must be summarized, not stringified — see
    // summarizeModelContent (base64 leak).
    content: summarizeModelContent(m.content),
  }));

  const userMessages = inbound.filter((m) => m.role === "user");
  const lastUserMessage = extractLastUserText(userMessages[userMessages.length - 1]);

  const input: TurnInput = {
    modelMessages,
    recentTurns,
    lastUserMessage,
    model,
    modelConfig,
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
    imageAttachments,
    ...(args.regenerate === true ? { regenerate: true } : {}),
  };

  const run = await start(turnWorkflow, [input]);

  return run;
}
