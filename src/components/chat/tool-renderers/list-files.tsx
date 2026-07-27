"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { FolderOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToolLayout } from "../tool-layout";

interface ListFilesRendererProps {
  toolName: string;
  input?: { path?: string };
  output?: Array<{ name: string; type: string }>;
  state: ToolRenderState;
}

export function ListFilesRenderer({ toolName: _toolName, input, output, state }: ListFilesRendererProps) {
  const t = useTranslations("chat.tool");
  const dirPath = input?.path ?? "...";
  const files = Array.isArray(output) ? output : [];

  const running = state.running;
  const displayName = running
    ? t("listRunning")
    : t("listDone", { count: files.length });

  const expandedContent = files.length > 0 ? (
    <div className="font-mono text-xs leading-relaxed text-muted-foreground">
      {files.map((f, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {f.type === "dir" ? "📁" : "📄"}
          </span>
          <span>{f.name}</span>
        </div>
      ))}
    </div>
  ) : undefined;

  const summary = (
    <span className="font-mono text-muted-foreground">
      {dirPath}
      {files.length > 0 && (
        <span className="ml-1.5 text-muted-foreground">
          ({t("items", { count: files.length })})
        </span>
      )}
    </span>
  );

  return (
    <ToolLayout
      name={displayName}
      icon={<FolderOpen className="h-3.5 w-3.5" />}
      summary={summary}
      meta={files.length > 0 ? t("items", { count: files.length }) : undefined}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
