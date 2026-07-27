"use client";

import { Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { PhaseIndicator } from "./phase-indicator";
import { MarkdownRenderer } from "./markdown";

interface ThinkingBlockProps {
  text: string;
  isStreaming?: boolean;
  /** Server-measured reasoning duration (ms) — preferred over the local timer,
      which is lost when the finished message re-renders from scratch. */
  durationMs?: number;
}

const COMPLETED_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const STREAMING_STATE: ToolRenderState = {
  running: true,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

export function ThinkingSteps({ text, isStreaming = false, durationMs }: ThinkingBlockProps) {
  const t = useTranslations("chat.phase");

  const hasContent = text.trim().length > 0;
  const seconds =
    durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : null;

  const label = isStreaming
    ? t("thinking")
    : seconds != null
      ? t("thoughtFor", { count: seconds })
      : t("thinkingDone");

  const expandedContent = hasContent ? (
    <MarkdownRenderer content={text} />
  ) : undefined;

  return (
    <PhaseIndicator
      mode="streaming"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={label}
      state={isStreaming ? STREAMING_STATE : COMPLETED_STATE}
      streamingText={isStreaming ? text : undefined}
      expandedContent={expandedContent}
    />
  );
}
