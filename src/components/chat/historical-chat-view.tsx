"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import type { SliceContent } from "@/lib/episodic/actions";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MarkdownRenderer } from "./markdown";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";

// ─── Types ──────────────────────────────────────────────────────────────

interface HistoricalChatViewProps {
  content: SliceContent | null;
  loading: boolean;
}

// ─── Single turn renderer ───────────────────────────────────────────────

function HistoryTurn({
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
    <div className="py-0.5">
      {/* Cognition — above agent bubble, left-aligned */}
      {!isUser && turnId && (
        <div className="flex justify-start mb-0.5 ml-1">
          <CognitionPopover sliceId={sliceId} turnId={turnId} />
        </div>
      )}
      <Message align={isUser ? "end" : "start"} className="gap-1">
        <MessageContent className="min-w-0">
          <Bubble variant={isUser ? "secondary" : "ghost"}>
            <BubbleContent>
              {isUser ? (
                <span className="whitespace-pre-wrap text-sm">{content}</span>
              ) : (
                <MarkdownRenderer content={content} />
              )}
            </BubbleContent>
          </Bubble>
          {/* Timestamp — below bubble */}
          <div
            className={`mt-0.5 text-muted-foreground/50 ${isUser ? "text-right" : "text-left"}`}
          >
            <TimeDisplay
              timestamp={timestamp}
              mode={sameDay(timestamp) ? "time" : "full"}
            />
          </div>
        </MessageContent>
      </Message>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────

export function HistoricalChatView({
  content,
  loading,
}: HistoricalChatViewProps) {
  const turns = useMemo(() => content?.turns ?? [], [content]);

  // ── Loading skeleton ──────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading conversation...
      </div>
    );
  }

  // ── Empty / not found ─────────────────────────────────────────────────
  if (!content) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground italic">
        Slice not found or unavailable.
      </div>
    );
  }

  // ── Empty slice ───────────────────────────────────────────────────────
  if (turns.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground italic">
        This time slice has no recorded turns.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8 py-3">
      {/* Turn list */}
      <div>
        {turns.map((turn, i) => (
          <HistoryTurn
            key={`${turn.timestamp}-${i}`}
            role={turn.role}
            content={turn.content}
            sliceId={content.slice_id}
            turnId={turn.turnId}
            timestamp={turn.timestamp}
          />
        ))}
      </div>

      {/* Footer: open loops / decisions */}
      {(content.open_loops.length > 0 ||
        content.decisions.length > 0) && (
        <div className="mt-4 pt-3 border-t border-border/50">
          {content.open_loops.length > 0 && (
            <div className="mb-2">
              <span className="text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide">
                Open Loops
              </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {content.open_loops.map((loop, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[0.65rem] text-muted-foreground"
                  >
                    <span className="text-[0.55rem] opacity-60">↗</span>
                    {loop}
                  </span>
                ))}
              </div>
            </div>
          )}
          {content.decisions.length > 0 && (
            <div>
              <span className="text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide">
                Decisions
              </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {content.decisions.map((d, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[0.65rem] text-muted-foreground"
                  >
                    <span className="text-[0.55rem] opacity-60">✓</span>
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
