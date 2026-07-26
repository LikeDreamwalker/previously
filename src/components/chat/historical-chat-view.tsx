"use client";

import { useMemo } from "react";
import { Brain, Loader2 } from "lucide-react";
import type { SliceContent } from "@/lib/episodic/actions";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MarkdownRenderer } from "./markdown";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

// ─── Main component ─────────────────────────────────────────────────────

export function HistoricalChatView({
  content,
  loading,
}: HistoricalChatViewProps) {
  const turns = useMemo(() => content?.turns ?? [], [content]);

  // ── First-ever load — no content at all ────────────────────────────────
  if (!content && loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading conversation...
      </div>
    );
  }

  // ── Not found (after load attempt) ──────────────────────────────────────
  if (!content) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground italic">
        Slice not found or unavailable.
      </div>
    );
  }

  // ── Content exists — always render it (even while loading next slice) ──
  return (
    <div className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8 py-3">
      {/* Subtle loading bar — only when transitioning to a new slice */}
      {loading && (
        <div className="mb-3 h-0.5 bg-muted-foreground/10 rounded-full overflow-hidden">
          <div className="h-full w-2/5 bg-muted-foreground/20 rounded-full animate-pulse" />
        </div>
      )}

      {/* ── Previously On bar + summary ──────────────────────────────────── */}
      <div className="mb-4">
        {/* Clickable bar — PhaseIndicator visual style, opens Dialog */}
        {content.previously ? (
          <Dialog>
            <DialogTrigger className="block w-full text-left rounded-lg px-3 py-2.5 cursor-pointer transition-colors hover:bg-muted/30">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-4 shrink-0 items-center justify-center text-brand">
                  <Brain className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 truncate text-sm font-semibold text-foreground/90">
                  前情提要
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  点击查看
                </span>
              </div>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm">
                  <Brain className="h-4 w-4" />
                  Previously On
                </DialogTitle>
              </DialogHeader>
              <div className="text-sm leading-relaxed">
                <MarkdownRenderer content={content.previously} />
              </div>
            </DialogContent>
          </Dialog>
        ) : (
          /* Non-clickable bar when no previously.md exists */
          <div className="rounded-lg px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-4 shrink-0 items-center justify-center text-brand">
                <Brain className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 truncate text-sm font-semibold text-foreground/90">
                前情提要
              </span>
            </div>
          </div>
        )}

        {/* Summary text — small muted, below the bar */}
        {content.summary && (
          <p className="mt-1 px-4 text-xs text-muted-foreground leading-relaxed">
            {content.summary}
          </p>
        )}
      </div>

      {/* Empty slice */}
      {turns.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground italic">
          This time slice has no recorded turns.
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
