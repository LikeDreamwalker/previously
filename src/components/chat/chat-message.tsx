"use client";

import { memo, useMemo } from "react";
import { useTranslations } from "next-intl";
import type { UIMessage } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { PhaseIndicator } from "./phase-indicator";
import { ToolLayout } from "./tool-layout";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Activity,
  AlertTriangle,
  Calendar,
  FileText,
  GitBranch,
  Tag,
  XCircle,
} from "lucide-react";
import { LoadingTip } from "./loading-tip";
import { EvolutionIndicator, type EvolutionState } from "./evolution-indicator";
import type { ToolRenderState } from "@/lib/chat/tool-state";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
  evolutionState?: EvolutionState | null;
}

// ── Unified stream: walk parts in natural order ────────────────────────

type AnyPart = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  data?: unknown;
};

type StreamItem =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; content: string }
  | { kind: "tool"; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown }
  | { kind: "phase"; phase: string; running?: boolean; mode?: string; summaries?: string[]; compact?: boolean };

/**
 * Maps a running-phase i18n key to its done-state key. `slicing` is kept for
 * backward compatibility with messages streamed before the housekeeping phases
 * were granularized; the current phases (slice/tags/context/strands) all carry
 * a `compact: true` flag and render as ToolLayout bars.
 */
const PHASE_DONE_KEYS: Record<string, string> = {
  slicing: "sliced",
  slice: "sliced",
  tags: "tagged",
  context: "contextLoaded",
  strands: "strandsWoven",
};

/** Per-housekeeping-phase icons for the compact ToolLayout bars. */
const COMPACT_PHASE_ICONS: Record<string, React.ReactNode> = {
  slice: <Calendar className="h-3 w-3" />,
  tags: <Tag className="h-3 w-3" />,
  context: <FileText className="h-3 w-3" />,
  strands: <GitBranch className="h-3 w-3" />,
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
    case "phase":
      return `phase-${item.phase}-${index}`;
  }
}

function buildStream(parts: readonly AnyPart[], isStreaming: boolean): StreamItem[] {
  const items: StreamItem[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      items.push({ kind: "text", content: textBuf.join("") });
      textBuf = [];
    }
  };

  for (const p of parts) {
    if (p.type === "reasoning") {
      flushText();
      const reasoningText = (p as { text: string }).text ?? "";
      // Merge consecutive reasoning deltas
      const last = items.length > 0 ? items[items.length - 1] : null;
      if (last?.kind === "reasoning") {
        last.text += reasoningText;
      } else {
        items.push({ kind: "reasoning", text: reasoningText });
      }
    } else if (p.type === "text") {
      textBuf.push((p as { text: string }).text ?? "");
    } else if (p.type === "data-phase") {
      flushText();
      const d = p.data as { phase?: string; running?: boolean; mode?: string; summaries?: string[]; compact?: boolean } | undefined;
      if (d?.phase) {
        // Merge with existing phase item of the same name — a phase emits
        // { running: true } at start and { running: false, summaries: [...] } at end.
        const existing = items.find(
          (it): it is Extract<StreamItem, { kind: "phase" }> =>
            it.kind === "phase" && it.phase === d.phase,
        );
        if (existing) {
          existing.running = d.running ?? false;
          if (d.mode !== undefined) existing.mode = d.mode;
          if (d.summaries !== undefined) existing.summaries = d.summaries;
          if (d.compact !== undefined) existing.compact = d.compact;
        } else {
          items.push({
            kind: "phase",
            phase: d.phase,
            running: d.running ?? false,
            mode: d.mode,
            summaries: d.summaries,
            compact: d.compact,
          });
        }
      }
    } else if (p.type === "data-turn-status") {
      // Terminal status only (done / interrupted / error) — the mid-turn
      // thinking/synthesizing lifecycle was removed when thinkDeep became an
      // agent-as-a-tool. Surface interrupted/error inline; done renders nothing
      // (the reply text is the completion signal).
      flushText();
      const status = (p.data as { status?: string } | undefined)?.status;
      if (!status || status === "active" || status === "done") continue;

      const terminalPhase =
        status === "interrupted" ? "terminal-interrupted" : "terminal-error";
      const existing = items.find(
        (it): it is Extract<StreamItem, { kind: "phase" }> =>
          it.kind === "phase" && it.phase === terminalPhase,
      );
      if (!existing) {
        items.push({
          kind: "phase",
          phase: terminalPhase,
          running: false,
          mode: "terminal",
          summaries: [],
        });
      }
    } else if (p.type?.startsWith("tool-")) {
      flushText();
      const toolCallId = (p as { toolCallId?: string }).toolCallId ?? `anon-${items.length}`;
      const toolName = (p as { toolName?: string }).toolName ?? p.type.replace("tool-", "");

      // Merge tool parts sharing the same toolCallId into one StreamItem.
      // The AI SDK emits separate parts for input-streaming → input-available →
      // output-available; we fold them into a single card so it doesn't remount.
      const existing = items.find(
        (it): it is Extract<StreamItem, { kind: "tool" }> =>
          it.kind === "tool" && it.toolCallId === toolCallId,
      );
      if (existing) {
        existing.state = p.state ?? existing.state;
        if (p.input !== undefined) existing.input = p.input;
        if (p.output !== undefined) existing.output = p.output;
      } else {
        items.push({
          kind: "tool",
          toolCallId,
          toolName,
          state: (p as { state?: string }).state ?? "running",
          input: p.input,
          output: p.output,
        });
      }
    }
  }
  flushText();

  return items;
}

export const ChatMessage = memo(function ChatMessage({ message, onRegenerate, isStreaming, startedAt, evolutionState }: ChatMessageProps) {
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
                        isStreaming={isStreaming ?? false}
                      />
                    );
                  }
                  if (item.kind === "phase") {
                    // Housekeeping sub-steps — unobtrusive ToolLayout bars.
                    if (item.compact) {
                      const doneKey = PHASE_DONE_KEYS[item.phase];
                      const label = item.running
                        ? t(item.phase)
                        : doneKey
                          ? t(doneKey)
                          : t(item.phase);
                      const compactState: ToolRenderState = {
                        running: item.running ?? false,
                        inputStreaming: false,
                        interrupted: false,
                        denied: false,
                        approvalRequested: false,
                        isActiveApproval: false,
                      };
                      return (
                        <ToolLayout
                          key={key}
                          name={label}
                          summary={item.summaries?.join(", ") ?? ""}
                          state={compactState}
                          icon={COMPACT_PHASE_ICONS[item.phase]}
                        />
                      );
                    }

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

                    // Regular phase — PhaseIndicator static.
                    const doneKey = PHASE_DONE_KEYS[item.phase];
                    const label = item.running
                      ? t(item.phase)
                      : doneKey
                        ? t(doneKey)
                        : t(item.phase);
                    const hasSummaries = item.summaries && item.summaries.length > 0;
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
                          hasSummaries
                            ? <div className="space-y-1 text-xs text-muted-foreground leading-relaxed">
                                {item.summaries!.map((s, j) => (
                                  <div key={j}>{s}</div>
                                ))}
                              </div>
                            : undefined
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
