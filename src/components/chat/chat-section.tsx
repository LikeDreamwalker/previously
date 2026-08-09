"use client";

import { memo } from "react";
import type { UIMessage } from "ai";
import { ChatMessage } from "./chat-message";
import { LoadingTip } from "./loading-tip";
import { Message, MessageContent } from "@/components/ui/message";
import type { EvolutionState } from "./evolution-indicator";

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
      {messages.map((message) => (
        <ChatMessage
          key={message.id}
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

      {error && (
        <div className="mx-4 my-2 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error.message}
        </div>
      )}
    </>
  );
});
