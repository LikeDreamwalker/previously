"use client";

import { useTranslations } from "next-intl";
import { Check, ListChecks, Loader2 } from "lucide-react";
import { PhaseIndicator } from "./phase-indicator";
import type { HousekeepingStep } from "@/lib/chat/build-stream";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { cn } from "@/lib/utils";

/**
 * Maps a running-phase i18n key to its done-state key. `slicing` is kept for
 * backward compatibility with messages streamed before the housekeeping phases
 * were granularized. Card evolution is NOT a housekeeping phase — it renders
 * as its own stream-positioned card (see evolution-card.tsx).
 */
export const PHASE_DONE_KEYS: Record<string, string> = {
  slicing: "sliced",
  slice: "sliced",
  tags: "tagged",
  context: "contextLoaded",
  strands: "strandsWoven",
  analyze: "analyzed",
};

/**
 * The grouped housekeeping card (EDGE mode) — the compact prep phases (slice /
 * analyze / tags / context / strands) fold into one faint brand-tinted card
 * with a live checklist. Collapsible while running.
 * Client mode does NOT use this: its housekeeping is one bridge agent call +
 * deterministic wrap-up, rendered as the streaming BridgeHousekeepingCard
 * (bridge-housekeeping-card.tsx).
 */
export function HousekeepingCard({ steps }: { steps: HousekeepingStep[] }) {
  const t = useTranslations("chat.phase");
  const anyRunning = steps.some((s) => s.running);
  const doneCount = steps.filter((s) => !s.running).length;

  const state: ToolRenderState = {
    running: anyRunning,
    inputStreaming: false,
    interrupted: false,
    denied: false,
    approvalRequested: false,
    isActiveApproval: false,
  };

  const checklist = (
    <ul className="space-y-1.5">
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
                s.running ? "text-brand-500" : "text-brand-600/70 dark:text-brand-400/70",
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
  );

  return (
    <PhaseIndicator
      mode="static"
      className="bg-brand-100/40 dark:bg-brand-400/[0.07]"
      icon={<ListChecks className="h-3.5 w-3.5" />}
      label={anyRunning ? t("housekeeping") : t("housekeepingDone")}
      summary={`${doneCount}/${steps.length}`}
      state={state}
      expandedContent={checklist}
    />
  );
}
