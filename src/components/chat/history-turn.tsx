"use client";

import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MarkdownRenderer } from "./markdown";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";

/**
 * A single historical turn — pure body bubbles (design §1.2: history renders
 * as plain text, no tool state). Rendered by the unified message stream.
 */
export function HistoryTurn({
  role,
  content,
  sliceId,
  turnId,
  timestamp,
}: {
  role: string;
  content: string;
  sliceId: string;
  turnId?: string;
  timestamp: string;
}) {
  const isUser = role === "user";

  return (
    <div className="py-1.5">
      <Message align={isUser ? "end" : "start"} className="gap-1">
        <MessageContent className="min-w-0">
          <Bubble variant={isUser ? "secondary" : "ghost"}>
            {/* Header row: timestamp [· 思考] */}
            <div className={`flex items-center gap-1.5 mb-1 font-mono text-[0.6rem] text-muted-foreground/50 ${isUser ? "justify-end" : ""}`}>
              <TimeDisplay
                timestamp={timestamp}
                mode={sameDay(timestamp) ? "time" : "full"}
              />
              {!isUser && turnId && (
                <>
                  <span aria-hidden>·</span>
                  <CognitionPopover sliceId={sliceId} turnId={turnId} />
                </>
              )}
            </div>
            <BubbleContent>
              {isUser ? (
                <span className="whitespace-pre-wrap text-sm">{content}</span>
              ) : (
                <MarkdownRenderer content={content} />
              )}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </div>
  );
}
