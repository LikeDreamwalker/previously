"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Image } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ViewImageRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

function resolveName(
  input: Record<string, unknown> | undefined,
  running: boolean,
  t: ReturnType<typeof useTranslations>,
): string {
  return running ? t("viewImageRunning") : t("viewImageDone");
}

/**
 * viewImage tool: one-shot image-to-text. Shows an image icon, the source
 * (URL or attachment:N), and the description in the expanded view.
 */
export function ViewImageRenderer({
  toolName: _toolName,
  input,
  output,
  state,
}: ViewImageRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;
  const source = typeof inp?.source === "string" ? inp.source : "";
  const isAttachment = source.startsWith("attachment:");
  const shortSource = source
    ? source.length > 48
      ? source.slice(0, 48) + "…"
      : source
    : null;

  const text = typeof output === "string" ? output : null;
  const isError = typeof text === "string" && text.startsWith("ERROR:");
  const displayText = isError ? null : text;

  const displayName = resolveName(inp, state.running, t);

  const displayState: ToolRenderState = {
    ...state,
    error: state.error ?? (isError ? text ?? "Unknown error" : undefined),
  };

  const expandedContent = displayText ? (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
      {displayText.length > 3000
        ? displayText.slice(0, 3000) + "\n…"
        : displayText}
    </pre>
  ) : undefined;

  return (
    <ToolLayout
      name={displayName}
      icon={<Image className="h-3.5 w-3.5" />}
      summary={
        shortSource ? (
          <span className="font-mono text-xs text-muted-foreground">
            {isAttachment ? shortSource : shortSource}
          </span>
        ) : null
      }
      summaryClassName="font-mono"
      state={displayState}
      expandedContent={expandedContent}
    />
  );
}
