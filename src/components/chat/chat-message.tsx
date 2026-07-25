"use client";

import { memo, useMemo } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { ToolLayout } from "./tool-layout";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { FileText } from "lucide-react";
import { LoadingTip } from "./loading-tip";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
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
  | { kind: "tool"; toolName: string; state: string; input?: unknown; output?: unknown }
  | { kind: "belief"; summaries: string[] };

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
    } else if (p.type === "data-belief") {
      flushText();
      const d = p.data as { summaries?: string[] } | undefined;
      const summaries = d?.summaries ?? [];
      if (summaries.length > 0) {
        items.push({ kind: "belief", summaries });
      }
    } else if (p.type?.startsWith("tool-")) {
      flushText();
      const toolName = p.toolName ?? p.type.replace("tool-", "");
      items.push({
        kind: "tool",
        toolName,
        state: p.state ?? "running",
        input: p.input,
        output: p.output,
      });
    }
  }
  flushText();

  return items;
}

export const ChatMessage = memo(function ChatMessage({ message, onRegenerate, isStreaming, startedAt }: ChatMessageProps) {
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
            <Bubble variant="default">
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
          {hasContent && (
            <div className="space-y-1">
              {streamItems.map((item, i) => {
                  if (item.kind === "reasoning") {
                    return (
                      <ThinkingSteps
                        key={`thinking-${i}`}
                        text={item.text}
                        isStreaming={isStreaming && i === streamItems.length - 1}
                      />
                    );
                  }
                  if (item.kind === "tool") {
                    return (
                      <ToolRenderer
                        key={`tool-${i}`}
                        toolName={item.toolName}
                        state={item.state}
                        input={item.input}
                        output={item.output}
                        isStreaming={isStreaming ?? false}
                      />
                    );
                  }
                  if (item.kind === "belief") {
                    return (
                      <ToolLayout
                        key={`belief-${i}`}
                        name="更新了前情提要"
                        summary=""
                        icon={<FileText className="h-3.5 w-3.5" />}
                        defaultExpanded
                        state={{
                          running: false,
                          inputStreaming: false,
                          interrupted: false,
                          denied: false,
                          approvalRequested: false,
                          isActiveApproval: false,
                        }}
                        expandedContent={
                          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1 text-xs text-muted-foreground leading-relaxed">
                            {item.summaries.map((s, j) => (
                              <div key={j}>{s}</div>
                            ))}
                          </div>
                        }
                      />
                    );
                  }
                  if (item.kind === "text") {
                    return (
                      <div key={`text-${i}`} className="[&:not(:last-child)]:mb-3">
                        <MarkdownRenderer
                          content={item.content}
                          isStreaming={isStreaming && i === streamItems.length - 1}
                        />
                      </div>
                    );
                  }
                  return null;
                })}
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
