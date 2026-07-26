"use client";

import type { UIMessage } from "ai";
import { ChatMessage } from "./chat-message";
import { LoadingTip } from "./loading-tip";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import type { EvolutionState } from "./evolution-indicator";

interface ChatSectionProps {
  messages: UIMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  error: Error | undefined;
  lastUserMessageAt: string | null;
  evolutionState?: EvolutionState | null;
}

export function ChatSection({
  messages,
  isStreaming,
  isLoading,
  error,
  lastUserMessageAt,
  evolutionState,
}: ChatSectionProps) {
  const lastMessage = messages[messages.length - 1];
  const hasAssistant = messages.some((m) => m.role === "assistant");
  const showPlaceholder = isLoading && !hasAssistant;

  return (
    <>
      {messages.map((message) => (
        <MessageScrollerItem
          key={message.id}
          messageId={message.id}
          scrollAnchor={message.role === "user"}
        >
          <ChatMessage
            message={message}
            isStreaming={message.id === lastMessage?.id && isStreaming}
            startedAt={
              message.id === lastMessage?.id
                ? (lastUserMessageAt ?? undefined)
                : undefined
            }
            evolutionState={
              message.role === "assistant" ? evolutionState : undefined
            }
          />
        </MessageScrollerItem>
      ))}

      {/* Placeholder bubble — shown during the brief "submitted" window
          before the first assistant message arrives. Once the assistant
          message exists, ChatMessage takes over the loading indicator. */}
      {showPlaceholder && (
        <MessageScrollerItem messageId="loading-placeholder">
          <div className="py-1">
            <Message align="start" className="gap-1">
              <MessageContent className="min-w-0">
                <LoadingTip />
              </MessageContent>
            </Message>
          </div>
        </MessageScrollerItem>
      )}

      {error && (
        <MessageScrollerItem messageId="error-banner">
          <div className="mx-4 my-2 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error.message}
          </div>
        </MessageScrollerItem>
      )}
    </>
  );
}
