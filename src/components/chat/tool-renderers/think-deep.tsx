"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { AlertTriangle, Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "../phase-indicator";
import { MarkdownRenderer } from "../markdown";

interface ThinkDeepToolRendererProps {
  input?: { question?: string; effort?: "low" | "medium" | "high" };
  output?: {
    ok?: boolean;
    status?: "completed" | "timeout" | "error";
    answer?: string;
    reasoning?: string;
    error?: string;
    note?: string;
  };
  state: ToolRenderState;
  /** Live reasoning/answer line from `data-tool-progress` — the streaming subtitle. */
  streamingText?: string;
  /** Progress stage ("reasoning" | "writing") — drives subtitle tone (dim vs primary). */
  streamingStage?: string;
}

function effortLabelKey(
  effort: "low" | "medium" | "high" | undefined,
): "thinkEffortLow" | "thinkEffortMedium" | "thinkEffortHigh" | null {
  switch (effort) {
    case "medium":
      return "thinkEffortMedium";
    case "high":
      return "thinkEffortHigh";
    case "low":
      return "thinkEffortLow";
    default:
      return null;
  }
}

/**
 * thinkDeep reasoning-fragment card — PhaseIndicator in streaming mode: while
 * the fragment runs, a single-line typewriter subtitle streams the live
 * reasoning tail (`data-tool-progress`); on completion the subtitle fades and
 * clicking expands the full answer + captured thinking trail (returned even
 * when the fragment was interrupted), or the failure reason.
 */
export function ThinkDeepToolRenderer({
  input,
  output,
  state,
  streamingText,
  streamingStage,
}: ThinkDeepToolRendererProps) {
  const t = useTranslations("chat.tool");

  const question = input?.question ?? "";

  const timedOut = output?.status === "timeout";
  const failed = output?.ok === false && !timedOut;
  const errorText = typeof output?.error === "string" ? output.error : null;
  const answer =
    typeof output?.answer === "string" && output.answer.trim()
      ? output.answer
      : null;
  const reasoning =
    typeof output?.reasoning === "string" && output.reasoning.trim()
      ? output.reasoning
      : null;
  const effortLabel = effortLabelKey(input?.effort);
  const effortText = effortLabel ? t(effortLabel) : null;

  // The fragment's captured thinking trail — collapsible inside the card.
  const reasoningBlock = reasoning ? (
    <details className="rounded-md border border-muted/60 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
        {t("thinkReasoning")}
      </summary>
      <div className="mt-2 border-t border-muted/40 pt-2">
        <MarkdownRenderer content={reasoning} />
      </div>
    </details>
  ) : null;

  // Normal reading order: thinking trail on top (collapsible), then the written
  // conclusion below it — like a thinking block above an answer, not the other
  // way around. The answer carries no extra heading; the content speaks for
  // itself.
  const expandedContent = timedOut ? (
    <div className="space-y-2">
      {reasoningBlock}
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-500">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {t("thinkTimedOut")}
      </div>
      {answer ? (
        <MarkdownRenderer content={answer} />
      ) : (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-amber-400">
          {errorText ?? t("thinkTimedOut")}
        </pre>
      )}
    </div>
  ) : failed ? (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-red-400">
      {errorText ?? "Unknown error"}
    </pre>
  ) : answer ? (
    <div className="space-y-2">
      {reasoningBlock}
      <MarkdownRenderer content={answer} />
    </div>
  ) : (
    <div className="space-y-2 font-mono text-xs leading-relaxed text-muted-foreground">
      {question && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("thinkQuestion")}
          </span>
          <span className="min-w-0 break-all">{question}</span>
        </div>
      )}
      {effortText && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("thinkEffort")}
          </span>
          <span className="min-w-0">{effortText}</span>
        </div>
      )}
    </div>
  );

  // Fold the fragment's own outcome (timeout/error from the output) into the
  // SDK part state so PhaseIndicator renders the right visual: amber
  // interrupted for a timeout, red error for a failure.
  const displayState: ToolRenderState = {
    ...state,
    interrupted: state.interrupted || timedOut,
    error:
      state.error ?? (failed ? (errorText ?? "Unknown error") : undefined),
  };

  // The written answer streams in the primary tone; the reasoning trail stays
  // in the dim thinking tone. The transition is the visible "thinking → answer"
  // handoff.
  const subtitleTone: "thinking" | "answer" =
    streamingStage === "writing" ? "answer" : "thinking";

  return (
    <PhaseIndicator
      mode="streaming"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={t("thinkDeep")}
      state={displayState}
      streamingText={streamingText}
      subtitleTone={subtitleTone}
      expandedContent={expandedContent}
    />
  );
}
