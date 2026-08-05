"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { AlertTriangle, Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";
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
}

const MAX_QUESTION_SUMMARY_LENGTH = 60;

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
 * thinkDeep reasoning-fragment card — a Brain icon with the sub-question as
 * summary. Expanded shows the fragment's answer plus its captured thinking
 * trail (returned even when the fragment was interrupted), or the failure
 * reason.
 */
export function ThinkDeepToolRenderer({
  input,
  output,
  state,
}: ThinkDeepToolRendererProps) {
  const t = useTranslations("chat.tool");

  const question = input?.question ?? "";
  const truncated =
    question.length > MAX_QUESTION_SUMMARY_LENGTH
      ? `${question.slice(0, MAX_QUESTION_SUMMARY_LENGTH)}…`
      : question;

  const summary = truncated ? (
    <span className="truncate text-muted-foreground text-xs">{truncated}</span>
  ) : null;

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
    <details className="mt-3 rounded-md border border-muted/60 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
        {t("thinkReasoning")}
      </summary>
      <div className="mt-2 border-t border-muted/40 pt-2">
        <MarkdownRenderer content={reasoning} />
      </div>
    </details>
  ) : null;

  const expandedContent = timedOut ? (
    <div className="space-y-2">
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
      {reasoningBlock}
    </div>
  ) : failed ? (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-red-400">
      {errorText ?? "Unknown error"}
    </pre>
  ) : answer ? (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        {t("thinkAnswer")}
      </div>
      <MarkdownRenderer content={answer} />
      {reasoningBlock}
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

  return (
    <ToolLayout
      name={t("thinkDeep")}
      icon={<Brain className="h-3.5 w-3.5" />}
      summary={summary}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
