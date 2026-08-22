"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Clock } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface CurrentTimeRendererProps {
  output?: unknown;
  state: ToolRenderState;
}

/**
 * currentTime tool: the agent's "watch check" (v0.9). A single-line card —
 * Clock icon, product-voiced label ("看了看表") — with the executor's rich-text
 * time report in the expanded view.
 */
export function CurrentTimeRenderer({ output, state }: CurrentTimeRendererProps) {
  const t = useTranslations("chat.tool");

  const text = typeof output === "string" ? output : null;
  const expandedContent = text ? (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
      {text}
    </pre>
  ) : undefined;

  return (
    <ToolLayout
      name={t("currentTime")}
      icon={<Clock className="h-3.5 w-3.5" />}
      summary={null}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
