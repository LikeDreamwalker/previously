"use client";

import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { ToolLayout } from "./tool-layout";
import { rowState, toolIcon } from "./bridge-tools-card";
import { PHASE_DONE_KEYS } from "./housekeeping-card";
import type { BridgeToolRow, HousekeepingStep } from "@/lib/chat/build-stream";
import { cn } from "@/lib/utils";

/**
 * The client-mode housekeeping card — the counterpart of the edge-mode
 * HousekeepingCard checklist. In client mode the whole housekeeping phase is
 * ONE bridge agent call plus a deterministic wrap-up, so instead of faking
 * the edge per-phase checklist (which would idle through the call, then jump
 * to done), this card streams continuously for the entire phase:
 *
 *   - the CLI's rolling narration line while the agent works (data.live);
 *   - one row per CLI tool event (same look as BridgeToolCard);
 *   - a wrap-up checklist that fills in as the kernel's engineering steps
 *     (slice / analyze / tags / context / strands) complete around the call.
 *
 * Data: cumulative `data-phase` frames (phase "bridgeHousekeeping"), merged
 * last-chunk-wins in build-stream — every frame carries the full tools list,
 * the current narration line, and the wrap-up steps.
 */
export function BridgeHousekeepingCard({
  running,
  tools,
  live,
  steps = [],
}: {
  running: boolean;
  tools: BridgeToolRow[];
  /** The CLI's rolling narration line — shown only while running. */
  live?: string;
  /** The kernel's wrap-up rows, filling in as the steps complete. */
  steps?: HousekeepingStep[];
}) {
  const t = useTranslations("chat.phase");
  const Icon = running ? Loader2 : Check;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1.0] }}
      className="rounded-lg bg-brand-100/40 px-3 py-2.5 dark:bg-brand-400/[0.07]"
    >
      {/* Header — same look as the other prep cards */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center text-brand">
          <Icon
            className={
              running ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
            }
          />
        </span>
        <span className="min-w-0 truncate text-sm font-semibold text-foreground/90">
          {t("bridgeHousekeeping")}
        </span>
        {tools.length > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {tools.length}
          </span>
        )}
      </div>

      {/* Rolling narration line — same styling as BridgeToolCard's live line
          (mono muted current line + pulsing caret). Shown only while running. */}
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

      {/* Wrap-up checklist — the kernel's engineering outcomes (slice id,
          applied tags, …) filling in around the agent call. Same row look as
          the edge-mode HousekeepingCard. */}
      {steps.length > 0 && (
        <ul className="mt-1.5 space-y-1.5 pl-6.5">
          {steps.map((s) => {
            const doneKey = PHASE_DONE_KEYS[s.phase];
            const label = s.running
              ? t(s.phase)
              : doneKey
                ? t(doneKey)
                : t(s.phase);
            return (
              <li key={s.phase} className="flex items-baseline gap-2 text-xs">
                <span
                  className={cn(
                    "flex size-3.5 shrink-0 items-center justify-center",
                    s.running
                      ? "text-brand-500"
                      : "text-brand-600/70 dark:text-brand-400/70",
                  )}
                >
                  {s.running ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                </span>
                <span className="min-w-0 text-muted-foreground">{label}</span>
                {!s.running && s.summaries && s.summaries.length > 0 && (
                  <span className="truncate font-mono text-[11px] leading-none text-muted-foreground/60">
                    {s.summaries.join(", ")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* One row per CLI tool event */}
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
