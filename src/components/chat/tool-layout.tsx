"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { CircleX, Loader2, Minus, OctagonPause, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import type React from "react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export type ToolLayoutProps = {
  name: string;
  summary: ReactNode;
  summaryClassName?: string;
  meta?: ReactNode;
  rightAlignMeta?: boolean;
  errorMeta?: ReactNode;
  state: ToolRenderState;
  output?: ReactNode;
  children?: ReactNode;
  expandedContent?: ReactNode;
  defaultExpanded?: boolean;
  icon?: ReactNode;
  nameClassName?: string;
  /** When true, the tool is receiving its input parameters (model still deciding args). */
  inputStreaming?: boolean;
};

function hasRenderableContent(value: ReactNode) {
  return (
    value !== null && value !== undefined && value !== false && value !== ""
  );
}

const EXPANDED_CONTENT_TRANSITION_MS = 200;

function trimErrorPrefix(message: string) {
  return message.replace(/^Error:\s*/i, "").trim();
}

export function ToolLayout({
  name,
  summary,
  summaryClassName,
  meta,
  rightAlignMeta = false,
  errorMeta,
  state,
  output,
  children,
  expandedContent,
  defaultExpanded = false,
  icon,
  nameClassName,
  inputStreaming,
}: ToolLayoutProps) {
  const t = useTranslations("chat.tool");
  const isInputStreaming = inputStreaming ?? state.inputStreaming;
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const errorMessage =
    state.error && !state.denied ? trimErrorPrefix(state.error) : undefined;
  const hasError = Boolean(errorMessage);
  const isInterrupted = Boolean(state.interrupted);
  const hasExpandedDetails =
    hasRenderableContent(expandedContent) || hasError || isInterrupted;
  const hasOutput = hasRenderableContent(output);
  const hasMeta = hasRenderableContent(meta);
  const hasSummary =
    typeof summary === "string" ? summary.trim().length > 0 : summary != null;
  const isExpandedPanelVisible = isExpanded && hasExpandedDetails;
  const [shouldRenderExpandedContent, setShouldRenderExpandedContent] =
    useState(defaultExpanded && hasExpandedDetails);

  const showErrorHeader = hasError;
  const showInterruptedHeader = isInterrupted && !hasError;
  const hasErrorMeta = hasRenderableContent(errorMeta);
  const hasTrailingMeta = !showErrorHeader && !showInterruptedHeader && hasMeta;
  const isRunning = state.running;

  // ── Error shake tracking ─────────────────────────────────────────────

  const prevErrorRef = useRef<string | undefined>(undefined);
  const [shake, setShake] = useState(false);

  useEffect(() => {
    if (errorMessage && errorMessage !== prevErrorRef.current) {
      prevErrorRef.current = errorMessage;
      setShake(true);
      const timer = setTimeout(() => setShake(false), 350);
      return () => clearTimeout(timer);
    }
    prevErrorRef.current = errorMessage;
  }, [errorMessage]);

  // ── Auto-expand during streaming, collapse when done ──────────────────

  const AUTO_COLLAPSE_DELAY_MS = 2000;

  const autoExpandedRef = useRef(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userHoveringRef = useRef(false);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer();
    collapseTimerRef.current = setTimeout(() => {
      if (!userHoveringRef.current) {
        setIsExpanded(false);
        autoExpandedRef.current = false;
      }
      // If the user IS hovering, the timer fired but we skipped collapse.
      // The onMouseLeave handler will re-schedule when they leave.
    }, AUTO_COLLAPSE_DELAY_MS);
  }, [clearCollapseTimer]);

  useEffect(() => {
    if (!hasExpandedDetails) return;

    if (isRunning) {
      // Streaming: auto-expand so the user can see live content.
      if (!isExpanded) {
        autoExpandedRef.current = true;
        setIsExpanded(true);
      }
      // Kill any collapse timer while still running.
      clearCollapseTimer();
    } else if (autoExpandedRef.current) {
      // Just finished (or arrived complete via defaultExpanded):
      // collapse after delay, unless the user is hovering.
      scheduleCollapse();
    }

    return clearCollapseTimer;
  }, [isRunning, hasExpandedDetails, isExpanded, clearCollapseTimer, scheduleCollapse]);

  // Handle the "arrived complete" case: defaultExpanded + not running →
  // start expanded, then auto-collapse after delay (like streaming case).
  useEffect(() => {
    if (!hasExpandedDetails) return;
    if (isRunning) return;
    if (!defaultExpanded) return;
    if (autoExpandedRef.current) return; // already handled by the other effect

    // One-time: expand on mount for completed data that arrived as one chunk.
    autoExpandedRef.current = true;
    setIsExpanded(true);
    scheduleCollapse();
    // Only fire once on mount / when defaultExpanded appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded, hasExpandedDetails]);

  // If the user manually toggles, hand control back permanently.
  const handleToggle = useCallback(() => {
    if (!hasExpandedDetails) return;
    if (!isExpanded) setShouldRenderExpandedContent(true);
    clearCollapseTimer();
    autoExpandedRef.current = false;
    setIsExpanded(!isExpanded);
  }, [hasExpandedDetails, isExpanded, clearCollapseTimer]);

  // Hover / touch on expanded content pauses the collapse timer.
  const handleExpandedEnter = useCallback(() => {
    userHoveringRef.current = true;
    clearCollapseTimer();
  }, [clearCollapseTimer]);

  const handleExpandedLeave = useCallback(() => {
    userHoveringRef.current = false;
    // Only re-schedule if auto-expanded (not manually toggled).
    if (autoExpandedRef.current) {
      scheduleCollapse();
    }
  }, [scheduleCollapse]);

  useEffect(() => {
    if (!hasExpandedDetails) {
      setShouldRenderExpandedContent(false);
      return;
    }
    if (isExpandedPanelVisible) {
      setShouldRenderExpandedContent(true);
      return;
    }
    if (!shouldRenderExpandedContent) return;
    const timeoutId = window.setTimeout(() => {
      setShouldRenderExpandedContent(false);
    }, EXPANDED_CONTENT_TRANSITION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [hasExpandedDetails, isExpandedPanelVisible, shouldRenderExpandedContent]);

  const resolvedIcon = isRunning ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
  ) : (
    icon ?? <StatusDot state={state} />
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.97 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        x: shake ? [0, -3, 3, -3, 3, 0] : 0,
      }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      layout
      transition={{
        opacity: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1.0] },
        y: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1.0] },
        scale: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1.0] },
        layout: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1.0] },
        x: shake ? { duration: 0.3, ease: "easeInOut" } : { duration: 0.15 },
      }}
      className={cn(
        "rounded-md border",
        isRunning && !isInputStreaming
          ? "border-primary/20"
          : "border-transparent",
        "bg-transparent",
      )}
    >
      {/* Shimmer bar — visible while model is deciding tool parameters */}
      {isInputStreaming && (
        <div className="h-0.5 rounded-full bg-gradient-to-r from-transparent via-primary/15 to-transparent bg-[length:200%_100%] animate-shimmer" />
      )}
      <div
        className={cn(
          "group flex min-w-0 select-none items-center gap-2 rounded-md px-1.5 py-1 text-sm",
          hasExpandedDetails &&
            "cursor-pointer transition-colors hover:bg-muted/50",
        )}
        {...(hasExpandedDetails && {
          onClick: handleToggle,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggle();
            }
          },
          role: "button",
          tabIndex: 0,
          "aria-expanded": isExpanded,
        })}
      >
        {/* Icon */}
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {showErrorHeader ? (
            <>
              <CircleX className="h-3.5 w-3.5 text-red-500 group-hover:hidden" />
              {isExpandedPanelVisible ? (
                <Minus className="hidden h-3.5 w-3.5 text-muted-foreground group-hover:block" />
              ) : (
                <Plus className="hidden h-3.5 w-3.5 text-muted-foreground group-hover:block" />
              )}
            </>
          ) : showInterruptedHeader ? (
            <>
              <OctagonPause className="h-3.5 w-3.5 text-yellow-500 group-hover:hidden" />
              {isExpandedPanelVisible ? (
                <Minus className="hidden h-3.5 w-3.5 text-muted-foreground group-hover:block" />
              ) : (
                <Plus className="hidden h-3.5 w-3.5 text-muted-foreground group-hover:block" />
              )}
            </>
          ) : hasExpandedDetails && !isRunning ? (
            <>
              <span className="group-hover:hidden">{resolvedIcon}</span>
              {isExpandedPanelVisible ? (
                <Minus className="hidden h-3.5 w-3.5 text-muted-foreground group-hover:block" />
              ) : (
                <Plus className="hidden h-3.5 w-3.5 text-muted-foreground group-hover:block" />
              )}
            </>
          ) : (
            resolvedIcon
          )}
        </span>

        {/* Name */}
        <span
          className={cn(
            "min-w-0 shrink truncate font-medium leading-none",
            showErrorHeader
              ? "text-red-500"
              : showInterruptedHeader
                ? "text-yellow-500"
                : state.denied
                  ? "text-red-500"
                  : "text-muted-foreground",
            nameClassName,
          )}
        >
          {name}
        </span>

        {/* Summary + Meta */}
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
          {hasSummary && (
            <span
              className={cn(
                "min-w-0 shrink truncate font-mono text-[13px] leading-none",
                showErrorHeader
                  ? "text-red-400/80"
                  : showInterruptedHeader
                    ? "text-yellow-400/80"
                    : "text-muted-foreground",
                summaryClassName,
              )}
            >
              {summary}
            </span>
          )}
          {(rightAlignMeta || showErrorHeader || showInterruptedHeader) && (
            <span className="flex-1" />
          )}
          {showErrorHeader && hasErrorMeta && (
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px] leading-none text-red-400/70">
              {errorMeta}
            </span>
          )}
          {hasTrailingMeta && (
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px] leading-none text-muted-foreground">
              {meta}
            </span>
          )}
        </div>
      </div>

      {children}

      {hasOutput && !state.interrupted && (
        <div className="mt-2 text-sm text-muted-foreground">{output}</div>
      )}

      {state.denied && (
        <div className="mt-2 text-sm text-red-500">
          {t("denied")}{state.denialReason ? `: ${state.denialReason}` : ""}
        </div>
      )}

      {hasExpandedDetails && (
        <div
          aria-hidden={!isExpandedPanelVisible}
          inert={!isExpandedPanelVisible}
          onMouseEnter={handleExpandedEnter}
          onMouseLeave={handleExpandedLeave}
          onTouchStart={handleExpandedEnter}
          onTouchEnd={handleExpandedLeave}
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows,opacity,margin-top] motion-reduce:transition-none",
            isExpandedPanelVisible
              ? "mt-1.5 grid-rows-[1fr] opacity-100 duration-200 ease-out"
              : "grid-rows-[0fr] opacity-0 pointer-events-none duration-150 ease-out",
          )}
        >
          <div className="min-h-0">
            {shouldRenderExpandedContent && (
              <div className="space-y-2 pb-1">
                {hasError && !hasRenderableContent(expandedContent) && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs leading-relaxed text-red-400">
                    {errorMessage}
                  </pre>
                )}
                {isInterrupted && (
                  <pre className="rounded-md border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 font-mono text-xs leading-relaxed text-yellow-500">
                    {t("interrupted")}
                  </pre>
                )}
                {expandedContent}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function StatusDot({ state }: { state: ToolRenderState }) {
  if (state.interrupted) {
    return (
      <span className="inline-block h-2 w-2 rounded-full border border-yellow-500" />
    );
  }
  const color = state.denied
    ? "bg-red-500"
    : state.approvalRequested
      ? "bg-yellow-500"
      : state.error
        ? "bg-red-500"
        : "bg-green-500";
  return <span className={cn("inline-block h-2 w-2 rounded-full", color)} />;
}
