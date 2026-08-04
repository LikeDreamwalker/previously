"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ThinkDeepToolRendererProps {
  input?: { question?: string; effort?: string; outputFormat?: string };
  output?: { ok?: boolean; thinkId?: string; status?: string; error?: string };
  state: ToolRenderState;
}

const MAX_QUESTION_SUMMARY_LENGTH = 60;

/**
 * thinkDeep dispatch card — a Brain icon with the sub-question as summary.
 * Expanded shows the dispatched thinkId + effort, or the failure reason.
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

  const failed = output?.ok === false;
  const thinkId = typeof output?.thinkId === "string" ? output.thinkId : null;
  const effort = input?.effort ?? "";
  const errorText = typeof output?.error === "string" ? output.error : null;

  const expandedContent = failed && errorText ? (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-red-400">
      {errorText}
    </pre>
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
      {effort && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("thinkEffort")}
          </span>
          <span className="min-w-0">{effort}</span>
        </div>
      )}
      {thinkId && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("thinkId")}
          </span>
          <span className="min-w-0 break-all">{thinkId}</span>
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
