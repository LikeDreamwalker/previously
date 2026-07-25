"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Loader2, ChevronDown } from "lucide-react";

export interface PhaseIndicatorProps {
  /** "streaming" = thinking (typewriter + auto-fade). "static" = recall (manual expand). */
  mode: "streaming" | "static";
  icon: ReactNode;
  label: string;
  summary?: ReactNode;
  meta?: ReactNode;
  state: ToolRenderState;
  /** Only for streaming mode — the reasoning text that arrives in deltas. */
  streamingText?: string;
  /** Card content when expanded. */
  expandedContent?: ReactNode;
}

const TICK_MS = 20;
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
  state,
  streamingText,
  expandedContent,
}: PhaseIndicatorProps) {
  const isRunning = state.running;
  const hasExpandedDetails = hasRenderableContent(expandedContent);
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldRenderExpandedContent, setShouldRenderExpandedContent] =
    useState(false);

  // ── Typewriter (streaming mode only) ──────────────────────────────────

  const [cursor, setCursor] = useState(0);
  const [typewriterVisible, setTypewriterVisible] = useState(true);
  const textRef = useRef(streamingText ?? "");
  textRef.current = streamingText ?? "";

  const text = streamingText ?? "";

  // Tick cursor forward as text grows.
  useEffect(() => {
    if (mode !== "streaming") return;
    if (cursor >= text.length) return;
    const id = setInterval(() => {
      setCursor((prev) => {
        if (prev >= textRef.current.length) return prev;
        return prev + 1;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [mode, text, cursor]);

  // Fade out typewriter after streaming finishes + fully typed.
  useEffect(() => {
    if (mode !== "streaming") return;
    if (isRunning || cursor < text.length || !text) return;
    const id = setTimeout(() => setTypewriterVisible(false), FADE_DELAY_MS);
    return () => clearTimeout(id);
  }, [mode, isRunning, cursor, text]);

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

  const display = mode === "streaming" ? text.slice(0, cursor) : "";
  const isTyping = mode === "streaming" && cursor < text.length;
  const showTypewriter = mode === "streaming" && text && typewriterVisible;

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
        {/* Icon */}
        <span className="flex size-4 shrink-0 items-center justify-center text-brand">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            icon
          )}
        </span>

        {/* Label */}
        <span className="min-w-0 truncate text-sm font-semibold text-foreground/90">
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

      {/* Typewriter line (streaming mode) */}
      <AnimatePresence>
        {showTypewriter && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 pl-6.5">
              <span className="text-xs leading-relaxed font-mono text-muted-foreground">
                {display}
                {isTyping && (
                  <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-brand/60 align-middle" />
                )}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading skeleton (streaming, no text yet) */}
      {mode === "streaming" && isRunning && !text && (
        <div className="mt-1.5 pl-6.5">
          <span className="inline-block h-3 w-32 animate-pulse rounded bg-brand/10" />
        </div>
      )}

      {/* Expanded Card */}
      {hasExpandedDetails && (
        <div
          aria-hidden={!isExpanded}
          inert={!isExpanded}
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
                <Card size="sm">
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
