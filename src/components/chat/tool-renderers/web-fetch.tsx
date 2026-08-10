"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface WebFetchRendererProps {
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
  const url = typeof input?.url === "string" ? input.url : "";
  return running
    ? t("webFetchRunning", { url: url || "…" })
    : t("webFetchDone", { url: url || "…" });
}

/**
 * webFetch tool: the web complement of readSlice — the main agent points at a
 * URL and gets the page's extracted text back. Link2 icon, the URL as the
 * label, the fetched prose in the expanded view (truncated for display).
 */
export function WebFetchRenderer({
  toolName: _toolName,
  input,
  output,
  state,
}: WebFetchRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;
  const url = typeof inp?.url === "string" ? inp.url : null;

  const text = typeof output === "string" ? output : null;
  const isError = typeof text === "string" && text.startsWith("ERROR:");
  const displayText = isError ? null : text; // error surfaces via state.error (red)

  const displayName = resolveName(inp, state.running, t);

  // Abbreviate the URL for the summary line — "https://example.com/a-long-…"
  const shortUrl = url ? (url.length > 48 ? url.slice(0, 48) + "…" : url) : null;

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
      icon={<Link2 className="h-3.5 w-3.5" />}
      summary={
        shortUrl ? (
          <span className="font-mono text-xs text-muted-foreground">
            {shortUrl}
          </span>
        ) : null
      }
      summaryClassName="font-mono"
      state={displayState}
      expandedContent={expandedContent}
    />
  );
}
