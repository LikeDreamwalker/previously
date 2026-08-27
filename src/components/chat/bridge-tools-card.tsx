"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import {
  Bot,
  FilePen,
  FileText,
  Globe,
  Loader2,
  Search,
  Terminal,
  Wrench,
  Check,
  type LucideIcon,
} from "lucide-react";
import { ToolLayout } from "./tool-layout";
import type { BridgeToolRow } from "@/lib/chat/build-stream";
import type { ToolRenderState } from "@/lib/chat/tool-state";

/**
 * The generic bridge-tool indicator (client + bridge mode): what the local
 * subscription CLI (claude) is doing while the user waits — one row per
 * protocol-2 tool event, both during housekeeping (phase
 * "bridgeHousekeeping") and the chat answer (phase "stageWorking").
 *
 * Each row: tool icon + name, status (running / ok / error), the pre-shortened
 * summary inline, expandable for the full summary text. Built on ToolLayout,
 * the same surface the kernel tool cards use.
 */

/** Known CLI tool names → icons; anything else gets the generic wrench. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  NotebookEdit: FilePen,
  Bash: Terminal,
  Grep: Search,
  Glob: Search,
  WebSearch: Globe,
  WebFetch: Globe,
  Task: Bot,
};

/** Exported for BridgeHousekeepingCard (the client-mode housekeeping card). */
export function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench;
}

/** Exported for BridgeHousekeepingCard (the client-mode housekeeping card). */
export function rowState(tool: BridgeToolRow): ToolRenderState {
  return {
    running: tool.status === "start",
    inputStreaming: false,
    interrupted: false,
    ...(tool.status === "error"
      ? { error: tool.summary || tool.name }
      : {}),
    denied: false,
    approvalRequested: false,
    isActiveApproval: false,
  };
}

/**
 * Seconds elapsed while `running` — the wait feedback for silent CLIs
 * (codex/kimi emit no events/deltas, so the timer is the only sign of life).
 * Same pattern as PhaseIndicator's elapsed timer.
 */
export function useElapsedSeconds(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

export function BridgeToolCard({
  phase,
  running,
  tools,
  live,
}: {
  /** i18n key under chat.phase ("stageWorking" / "bridgeHousekeeping"). */
  phase: string;
  running: boolean;
  tools: BridgeToolRow[];
  /** The CLI's rolling narration line — shown only while running. */
  live?: string;
}) {
  const t = useTranslations("chat.phase");
  const Icon = running ? Loader2 : Check;
  const elapsed = useElapsedSeconds(running);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1.0] }}
      className="rounded-lg bg-brand-100/40 px-3 py-2.5 dark:bg-brand-400/[0.07]"
    >
      {/* Header — mirrors the housekeeping card's look */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center text-brand">
          <Icon
            className={
              running ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
            }
          />
        </span>
        <span className="min-w-0 truncate text-sm font-semibold text-foreground/90">
          {t(phase)}
        </span>
        {tools.length > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {tools.length}
          </span>
        )}
        {running && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {elapsed}s
          </span>
        )}
      </div>

      {/* Rolling narration line — same styling as the evolution card's live
          thinking line (mono muted current line + pulsing caret). Hidden when
          absent or settled. */}
      {running && live && (
        <div className="mt-1.5 pl-6.5">
          <div
            className="overflow-x-auto whitespace-nowrap"
            style={{ scrollbarWidth: "none" }}
          >
            <span className="font-mono text-xs text-muted-foreground">
              {live}
              <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-brand-500 align-middle" />
            </span>
          </div>
        </div>
      )}

      {/* One row per tool event */}
      {tools.length > 0 && (
        <div className="mt-1">
          {tools.map((tool, i) => {
            const RowIcon = toolIcon(tool.name);
            return (
              <ToolLayout
                key={`${i}-${tool.name}`}
                name={tool.name}
                summary={tool.summary}
                icon={<RowIcon className="h-3 w-3" />}
                state={rowState(tool)}
                expandedContent={
                  tool.summary ? (
                    <p className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
                      {tool.summary}
                    </p>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
