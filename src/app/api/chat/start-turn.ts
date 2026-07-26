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
import { resolveModelId } from "@/lib/models/registry";
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

export async function startTurn(
  args: StartTurnArgs
): Promise<Awaited<ReturnType<typeof start>>> {
  const config = await loadUserConfig();
  // resolveModelId: the client's stored model preference may predate V4.
  const model = resolveModelId(args.model || config.model.provider);
  const thinking = args.thinking !== false && config.model.thinking;
  const reasoningEffort = args.effort ?? config.model.reasoningEffort;
  const clientTimezone = args.timezone ?? "UTC";
  const { owner, repo } = getRepoConfig();
  const dataSource = resolveDataSource();

  // Generate turn identity early — shared by user turn, agent turn, and
  // agent.md cognition record. 4 random bytes → 6-char base64url, unique
  // within a slice (and collision probability across 2^32 ≈ 4.3B values is
  // negligible for a time slice's lifetime).
  const turnId = crypto.randomBytes(4).toString("base64url");

  // Full turns, no truncation. The limit comes from user config so it can be
  // tuned without a redeploy.
  const modelMessages = await convertToModelMessages(args.messages);
  const recentTurns = modelMessages
    .slice(-Math.ceil(config.context.recentTurnsLimit * 1.2))
    .map((m) => ({
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
    thinking,
    reasoningEffort,
    clientTimezone,
    config,
    owner,
    repo,
    useGithub: dataSource === "github",
    useDemo: dataSource === "demo",
    startedAtIso: new Date().toISOString(),
    turnId,
  };

  return start(turnWorkflow, [input]);
}
