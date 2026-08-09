"use client";

import { memo, useMemo, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { UIMessage } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { PhaseIndicator } from "./phase-indicator";
import { HousekeepingCard } from "./housekeeping-card";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Activity,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { LoadingTip } from "./loading-tip";
import { EvolutionIndicator, type EvolutionState } from "./evolution-indicator";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import {
  buildStream,
  deriveAgentStage,
  type AnyPart,
  type StreamItem,
  type AgentStage,
} from "@/lib/chat/build-stream";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
  evolutionState?: EvolutionState | null;
}

// ── i18n key lookup for the live agent-stage pill ───────────────────────

const STAGE_KEYS: Record<AgentStage, string> = {
  recalling: "stageRecalling",
  reasoning: "stageReasoning",
  working: "stageWorking",
  composing: "stageComposing",
};

/** How long without a new stream part before the "still working" nudge shows. */
const SILENT_MS = 10000;

// ── Unified stream: walk parts in natural order ────────────────────────

/**
 * Maps a running-phase i18n key to its done-state key. `slicing` is kept for
 * backward compatibility with messages streamed before the housekeeping phases
 * were granularized; the current phases (slice/tags/context/strands) merge into
 * the HousekeepingCard instead.
 */
const PHASE_DONE_KEYS: Record<string, string> = {
  slicing: "sliced",
  slice: "sliced",
  tags: "tagged",
  context: "contextLoaded",
  strands: "strandsWoven",
};

/** Stable key for a stream item — used by AnimatePresence for enter/exit animation. */
function itemKey(item: StreamItem, index: number): string {
  switch (item.kind) {
    case "reasoning":
      return `reasoning-${index}`;
    case "text":
      return `text-${index}`;
    case "tool":
      return `tool-${item.toolCallId}`;
    case "housekeeping":
      return `housekeeping-${index}`;
    case "phase":
      return `phase-${item.phase}-${index}`;
  }
}

export const ChatMessage = memo(function ChatMessage({
  message,
  onRegenerate,
  isStreaming,
  startedAt,
  evolutionState,
}: ChatMessageProps) {
  const t = useTranslations("chat.phase");
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const parts = useMemo(
    () => (message.parts ?? []) as AnyPart[],
    [message.parts],
  );

  const streamItems = useMemo(
    () => (isAssistant ? buildStream(parts, isStreaming ?? false) : []),
    [parts, isAssistant, isStreaming],
  );

  // ── Live agent-stage pill ─────────────────────────────────────────────
  // Derives what the agent is doing right now (recalling / reasoning /
  // working / composing) from the part stream; shown only while streaming.
  const stage = useMemo(
    () => (isAssistant ? deriveAgentStage(parts) : null),
    [parts, isAssistant],
  );

  // ── Silence heartbeat ─────────────────────────────────────────────────
  // If the stream stalls (no new part for SILENT_MS), surface a "still
  // working" nudge so a long step never reads as dead. Client-only; the
  // server never needs to know.
  const lastPartsRef = useRef(Date.now());
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    lastPartsRef.current = Date.now();
    setSilent(false);
  }, [message.parts]);

  useEffect(() => {
    if (!isAssistant || !isStreaming) return;
    const id = window.setInterval(() => {
      setSilent(Date.now() - lastPartsRef.current > SILENT_MS);
    }, 2000);
    return () => window.clearInterval(id);
  }, [isAssistant, isStreaming]);

  // Full text for footer / actions
  const textContent = streamItems
    .filter((item) => item.kind === "text")
    .map((item) => (item as { kind: "text"; content: string }).content)
    .join("\n");

  const hasContent = streamItems.length > 0;

  // ── User message ──────────────────────────────────────────────────
  if (isUser) {
    const userText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    return (
      <div className="py-1">
        <Message align="end" className="gap-1">
          <MessageContent className="min-w-0">
            <Bubble variant="secondary">
              <BubbleContent>
                <MarkdownRenderer content={userText} />
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      </div>
    );
  }

  // ── Assistant: unified stream inside one bubble ────────────────────
  return (
    <div className="py-1">
      <Message align="start" className="gap-1">
        <MessageContent className="min-w-0">
          {/* Self-evolution indicator — per-bubble, same position as thinking/recall/phase */}
          <EvolutionIndicator state={evolutionState} />

          {/* Live agent-stage pill — a small brand marker of what the agent is doing */}
          {isStreaming && stage && (
            <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
              <span className="size-1.5 animate-pulse rounded-full bg-brand-500" />
              {t(STAGE_KEYS[stage])}
            </div>
          )}

          {hasContent && (
            <div className="space-y-1">
              <AnimatePresence>
                {streamItems.map((item, i) => {
                  const key = itemKey(item, i);

                  if (item.kind === "reasoning") {
                    return (
                      <ThinkingSteps
                        key={key}
                        text={item.text}
                        isStreaming={isStreaming && i === streamItems.length - 1}
                      />
                    );
                  }
                  if (item.kind === "tool") {
                    return (
                      <ToolRenderer
                        key={key}
                        toolName={item.toolName}
                        state={item.state}
                        input={item.input}
                        output={item.output}
                        streamingText={item.streamingText}
                        streamingStage={item.streamingStage}
                        isStreaming={isStreaming ?? false}
                      />
                    );
                  }
                  if (item.kind === "housekeeping") {
                    return <HousekeepingCard key={key} steps={item.steps} />;
                  }
                  if (item.kind === "phase") {
                    // Terminal interrupted/error — prominent static card.
                    if (item.mode === "terminal") {
                      const isInterrupted = item.phase.includes("interrupted");
                      return (
                        <PhaseIndicator
                          key={key}
                          mode="static"
                          icon={
                            isInterrupted ? (
                              <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-red-500" />
                            )
                          }
                          label={
                            isInterrupted
                              ? t("turnInterrupted")
                              : t("turnError")
                          }
                          state={{
                            running: false,
                            inputStreaming: false,
                            interrupted: isInterrupted,
                            denied: false,
                            approvalRequested: false,
                            isActiveApproval: false,
                          }}
                        />
                      );
                    }

                    // Regular (non-compact) phase — PhaseIndicator static.
                    const doneKey = PHASE_DONE_KEYS[item.phase];
                    const label = item.running
                      ? t(item.phase)
                      : doneKey
                        ? t(doneKey)
                        : t(item.phase);
                    const hasSummaries =
                      item.summaries && item.summaries.length > 0;
                    return (
                      <PhaseIndicator
                        key={key}
                        mode="static"
                        icon={<Activity className="h-3.5 w-3.5" />}
                        label={label}
                        state={{
                          running: item.running ?? false,
                          inputStreaming: false,
                          interrupted: false,
                          denied: false,
                          approvalRequested: false,
                          isActiveApproval: false,
                        }}
                        expandedContent={
                          hasSummaries ? (
                            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                              {item.summaries!.map((s, j) => (
                                <div key={j}>{s}</div>
                              ))}
                            </div>
                          ) : undefined
                        }
                      />
                    );
                  }

                  if (item.kind === "text") {
                    return (
                      <motion.div
                        key={key}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.15 }}
                        className="px-3 [&:not(:last-child)]:mb-3"
                      >
                        <MarkdownRenderer
                          content={item.content}
                          isStreaming={isStreaming && i === streamItems.length - 1}
                        />
                      </motion.div>
                    );
                  }
                  return null;
                })}
              </AnimatePresence>
            </div>
          )}

          {/* Loading indicator — persists for the full bubble lifetime */}
          {isStreaming && isAssistant && (
            <div className="pt-1.5">
              <LoadingTip />
            </div>
          )}

          {/* Silence heartbeat — only when the stream has gone quiet mid-turn */}
          {isStreaming && silent && (
            <div className="flex items-center gap-1.5 pt-1.5 text-xs text-muted-foreground/70">
              <span className="size-1.5 animate-pulse rounded-full bg-brand-500/70" />
              {t("stillWorking")}
            </div>
          )}

          {/* Footer — actions only */}
          {isAssistant && textContent && !isStreaming && onRegenerate && (
            <MessageFooter>
              <MessageActions content={textContent} onRegenerate={onRegenerate} />
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </div>
  );
});
