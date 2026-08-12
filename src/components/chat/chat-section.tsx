"use client";

import { memo, useEffect } from "react";
import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { ChatMessage } from "./chat-message";
import { LoadingTip } from "./loading-tip";
import { Message, MessageContent } from "@/components/ui/message";
import type { EvolutionState } from "./evolution-indicator";
import { useTranslations } from "next-intl";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

interface ChatSectionProps {
  messages: UIMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  error: Error | undefined;
  lastUserMessageAt: string | null;
  evolutionState: EvolutionState | null;
  isEvolutionTarget: (messageId: string) => boolean;
}

export const ChatSection = memo(function ChatSection({
  messages,
  isStreaming,
  isLoading,
  error,
  lastUserMessageAt,
  evolutionState,
  isEvolutionTarget,
}: ChatSectionProps) {
  const lastMessage = messages[messages.length - 1];
  const hasAssistant = messages.some((m) => m.role === "assistant");
  const showPlaceholder = isLoading && !hasAssistant;

  return (
    <>
      {messages.map((message, index) => (
        <ChatMessage
          // Index-suffixed key: if a reconnect ever delivers a duplicated
          // message id (the same turn written twice by concurrent streams),
          // the key stays unique — React's duplicate-key reconciliation can
          // otherwise loop into "Maximum update depth exceeded" (#185). The
          // chat list is append-only, so id+index keys remain stable for the
          // streaming in-place updates.
          key={`${message.id}-${index}`}
          message={message}
          isStreaming={message.id === lastMessage?.id && isStreaming}
          startedAt={
            message.id === lastMessage?.id
              ? (lastUserMessageAt ?? undefined)
              : undefined
          }
          evolutionState={
            isEvolutionTarget(message.id) ? evolutionState : null
          }
        />
      ))}

      {/* Placeholder bubble — shown during the brief "submitted" window
          before the first assistant message arrives. */}
      {showPlaceholder && (
        <div className="py-1">
          <Message align="start" className="gap-1">
            <MessageContent className="min-w-0">
              <LoadingTip />
            </MessageContent>
          </Message>
        </div>
      )}

      {error && <ErrorBanner error={error} />}
    </>
  );
});

/**
 * The red chat-error banner. The `error` object carries far more than `.message`
 * (name / stack / cause / statusCode), so render the full detail in an
 * expandable block AND log it — the minified production message alone is not
 * enough to locate the fault.
 */
function ErrorBanner({ error }: { error: Error }): ReactNode {
  const t = useTranslations("errorBoundary");
  useEffect(() => {
    console.error("[ChatSection][error banner]", formatErrorDetail(error));
  }, [error]);
  return (
    <div className="mx-4 my-2 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <div className="font-medium">{error.message}</div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs opacity-80">
          {t("fullError")}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/20 bg-background p-2 font-mono text-xs leading-relaxed">
          {formatErrorDetail(error)}
        </pre>
      </details>
    </div>
  );
}
