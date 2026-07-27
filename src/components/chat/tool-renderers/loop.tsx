"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Repeat } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface LoopToolRendererProps {
  input?: { goal?: string; tags?: string[] };
  output?: {
    ok?: boolean;
    loopId?: string;
    filePath?: string;
    error?: string;
  };
  state: ToolRenderState;
}

const MAX_GOAL_SUMMARY_LENGTH = 60;

export function LoopToolRenderer({ input, output, state }: LoopToolRendererProps) {
  const t = useTranslations("chat.tool");

  const goal = input?.goal ?? "";
  const truncatedGoal =
    goal.length > MAX_GOAL_SUMMARY_LENGTH
      ? `${goal.slice(0, MAX_GOAL_SUMMARY_LENGTH)}…`
      : goal;

  const summary = truncatedGoal ? (
    <span className="truncate text-muted-foreground text-xs">
      {truncatedGoal}
    </span>
  ) : null;

  // Discriminate the output shape: a completed loop either succeeded
  // (ok + loopId + filePath) or failed (ok === false + error).
  const failed = output?.ok === false;
  const loopId = typeof output?.loopId === "string" ? output.loopId : null;
  const filePath = typeof output?.filePath === "string" ? output.filePath : null;
  const errorText = typeof output?.error === "string" ? output.error : null;

  const expandedContent = failed && errorText ? (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-red-400">
      {errorText}
    </pre>
  ) : loopId || filePath ? (
    <div className="space-y-2 font-mono text-xs leading-relaxed text-muted-foreground">
      {filePath && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("loopFile")}
          </span>
          <span className="min-w-0 break-all">{filePath}</span>
        </div>
      )}
      {loopId && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("loopId")}
          </span>
          <span className="min-w-0 break-all">{loopId}</span>
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <ToolLayout
      name={t("startLoop")}
      icon={<Repeat className="h-3.5 w-3.5" />}
      summary={summary}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
