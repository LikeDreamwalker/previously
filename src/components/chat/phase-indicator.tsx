"use client";

import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Loader2, ChevronDown, CircleX, OctagonPause } from "lucide-react";

interface PhaseIndicatorProps {
  /** "streaming" = thinking (typewriter + auto-fade). "static" = recall (manual expand). */
  mode: "streaming" | "static";
  icon: ReactNode;
  label: string;
  summary?: ReactNode;
  meta?: ReactNode;
  /** Extra classes on the card container — used for brand-tier tint washes. */
  className?: string;
  state: ToolRenderState;
  /** Only for streaming mode — the reasoning text that arrives in deltas. */
  streamingText?: string;
  /**
   * Tone of the streaming subtitle — "thinking" (dim mono, default) vs
   * "answer" (primary color, normal weight) so a tool that streams its
   * thinking then its written answer visibly transitions between the two.
   */
  subtitleTone?: "thinking" | "answer";
  /** Card content when expanded. */
  expandedContent?: ReactNode;
}

const FADE_DELAY_MS = 2000;
const EXPANDED_CONTENT_TRANSITION_MS = 200;

function hasRenderableContent(value: ReactNode) {
  return value !== null && value !== undefined && value !== false && value !== "";
}

export function PhaseIndicator({
  mode,
  icon,
  label,
  summary,
  meta,
  className,
  state,
  streamingText,
  subtitleTone = "thinking",
  expandedContent,
}: PhaseIndicatorProps) {
  const isRunning = state.running;
  const isError = Boolean(state.error);
  const isInterrupted = state.interrupted;
  const isDenied = state.denied;
  const hasExpandedDetails = hasRenderableContent(expandedContent);
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldRenderExpandedContent, setShouldRenderExpandedContent] =
    useState(false);

  // ── Subtitle-style streaming (streaming mode only) ────────────────────

  const [typewriterVisible, setTypewriterVisible] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const text = streamingText ?? "";

  // Current line = everything after the last newline (subtitle style)
  const currentLine = useMemo(() => {
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
  }, [text]);

  // Track newline count for line-transition animation.
  // We key on newline count rather than currentLine content so the line only
  // remounts (and fades in) when a newline actually starts a new line — not on
  // every incremental character update during streaming.
  const newlineCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") count++;
    }
    return count;
  }, [text]);

  // Track newline transitions for fade animation
  const [lineKey, setLineKey] = useState(0);
  const prevNewlineCountRef = useRef(newlineCount);
  useEffect(() => {
    if (mode !== "streaming") return;
    if (newlineCount !== prevNewlineCountRef.current) {
      setLineKey((k) => k + 1);
      prevNewlineCountRef.current = newlineCount;
    }
  }, [mode, newlineCount]);

  // Auto-scroll to end as text streams in
  useEffect(() => {
    if (mode !== "streaming") return;
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [mode, currentLine]);

  // Fade out the subtitle line after streaming finishes
  useEffect(() => {
    if (mode !== "streaming") return;
    if (isRunning || !text) return;
    const id = setTimeout(() => setTypewriterVisible(false), FADE_DELAY_MS);
    return () => clearTimeout(id);
  }, [mode, isRunning, text]);

  // ── Elapsed timer (streaming mode only) ───────────────────────────────

  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (mode !== "streaming") return;
    if (!isRunning) {
      if (startTimeRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    if (startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }
    intervalRef.current = setInterval(() => {
      setElapsed(
        Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000),
      );
    }, 1000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      startTimeRef.current = null;
    };
  }, [mode, isRunning]);

  // ── Expand / collapse ─────────────────────────────────────────────────

  // In streaming mode, only allow toggle after running completes.
  const canToggle = mode === "static"
    ? hasExpandedDetails
    : hasExpandedDetails && !isRunning;

  const handleToggle = useCallback(() => {
    if (!canToggle) return;
    if (!isExpanded) setShouldRenderExpandedContent(true);
    setIsExpanded(!isExpanded);
  }, [canToggle, isExpanded]);

  // Delay unmount of the Card DOM until the collapse animation finishes.
  useEffect(() => {
    if (!hasExpandedDetails) {
      setShouldRenderExpandedContent(false);
      return;
    }
    if (isExpanded) {
      setShouldRenderExpandedContent(true);
      return;
    }
    if (!shouldRenderExpandedContent) return;
    const timeoutId = window.setTimeout(() => {
      setShouldRenderExpandedContent(false);
    }, EXPANDED_CONTENT_TRANSITION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [hasExpandedDetails, isExpanded, shouldRenderExpandedContent]);

  // ── Derived display values ────────────────────────────────────────────

  const isStreamingText = mode === "streaming" && isRunning && text.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      layout
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1.0] }}
      className={cn(
        "rounded-lg px-3 py-2.5",
        canToggle && "cursor-pointer transition-colors hover:bg-muted/30",
        className,
      )}
      onClick={canToggle ? handleToggle : undefined}
      onKeyDown={
        canToggle
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleToggle();
              }
            }
          : undefined
      }
      {...(canToggle && {
        role: "button",
        tabIndex: 0,
        "aria-expanded": isExpanded,
      })}
    >
      {/* Header row */}
      <div className="flex min-w-0 items-center gap-2">
        {/* Icon — spinner while running, then error/interrupted states, then the caller's icon */}
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            isError || isDenied
              ? "text-red-500"
              : isInterrupted
                ? "text-yellow-600"
                : "text-brand",
          )}
        >
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isError || isDenied ? (
            <CircleX className="h-3.5 w-3.5" />
          ) : isInterrupted ? (
            <OctagonPause className="h-3.5 w-3.5" />
          ) : (
            icon
          )}
        </span>

        {/* Label */}
        <span
          className={cn(
            "min-w-0 truncate text-sm font-semibold",
            isError || isDenied
              ? "text-red-500"
              : isInterrupted
                ? "text-yellow-600"
                : "text-foreground/90",
          )}
        >
          {label}
        </span>

        {/* Elapsed (streaming) */}
        {mode === "streaming" && elapsed > 0 && isRunning && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {elapsed}s
          </span>
        )}

        {/* Meta (static, finished) */}
        {mode === "static" && meta && !isRunning && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {meta}
          </span>
        )}

        {/* Summary (static) */}
        {mode === "static" && summary && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {summary}
          </span>
        )}

        {/* Expand chevron */}
        {canToggle && !isRunning && (
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              isExpanded && "rotate-180",
            )}
          />
        )}
      </div>

      {/* Subtitle area (streaming mode) — single container to avoid flicker */}
      <AnimatePresence>
        {mode === "streaming" && typewriterVisible && (isRunning || text) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 pl-6.5">
              {text ? (
                <motion.div
                  key={lineKey}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.15 }}
                  ref={scrollRef}
                  className="overflow-x-auto whitespace-nowrap"
                  style={{ scrollbarWidth: "none" }}
                >
                  <span
                    className={cn(
                      "text-xs",
                      subtitleTone === "answer"
                        ? "text-foreground"
                        : "font-mono text-muted-foreground",
                    )}
                  >
                    {currentLine}
                    {isStreamingText && (
                      <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-brand-500 align-middle" />
                    )}
                  </span>
                </motion.div>
              ) : (
                <span className="inline-block h-3 w-32 animate-pulse rounded bg-brand-500/10" />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Expanded Card */}
      {hasExpandedDetails && (
        <div
          aria-hidden={!isExpanded}
          inert={!isExpanded}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows,opacity,margin-top] motion-reduce:transition-none",
            isExpanded
              ? "mt-2 grid-rows-[1fr] opacity-100 duration-200 ease-out"
              : "grid-rows-[0fr] opacity-0 pointer-events-none duration-150 ease-out",
          )}
        >
          <div className="min-h-0">
            {shouldRenderExpandedContent && (
              <div className="pb-1 pt-1.5">
                {/* ring-inset: the Card's ring is a box-shadow that the grid's
                    overflow-hidden would otherwise clip on the left/right (the
                    card is flush with the clip container). Drawing it inset
                    keeps the border visible. */}
                <Card size="sm" className="ring-inset">
                  <CardContent className="max-h-80 overflow-auto text-sm">
                    {expandedContent}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
