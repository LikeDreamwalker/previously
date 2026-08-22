"use client";

import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { PhaseIndicator } from "./phase-indicator";
import {
  progressStageTone,
  type EvolutionStepData,
} from "@/lib/chat/build-stream";
import type { ToolRenderState } from "@/lib/chat/tool-state";

/**
 * The terminal detail of an evolution run: the actual card diff (added /
 * removed lines) plus the reviewer's reasoning note. Rendered as the card's
 * expandable content once the run settles. (Extracted from the retired
 * housekeeping sub-step row.)
 */
function EvolutionDetail({ data }: { data: EvolutionStepData }) {
  const hasMutations = (data.mutations?.length ?? 0) > 0;
  const hasNote = Boolean(data.note?.trim());
  if (!hasMutations && !hasNote) return null;
  return (
    <div className="space-y-2 pt-1">
      {hasMutations && (
        <ul className="space-y-1 font-mono text-xs leading-relaxed">
          {data.mutations!.map((m, i) => (
            <li
              key={i}
              className={
                m.type === "added"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-500/80"
              }
            >
              {m.type === "added" ? "+ " : "− "}
              {m.text}
            </li>
          ))}
        </ul>
      )}
      {hasNote && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {data.note}
        </p>
      )}
    </div>
  );
}

/**
 * The standalone evolution card — the inline card-evolution run (Previously
 * Agent) at its natural stream position (between the housekeeping context and
 * strands phases). While running, the Previously Agent's realtime thinking
 * line streams as the typewriter subtitle (falling back to the coarse
 * reading/reviewing step until the first live line arrives); the terminal
 * state shows the agent's one-sentence summary (falling back to the change
 * counts) with the mutations diff + note expandable, "checked, no updates",
 * or the failure reason in red.
 */
export function EvolutionCard({
  running,
  data,
}: {
  running: boolean;
  data: EvolutionStepData;
}) {
  const t = useTranslations("chat.evolution");

  let label: string;
  if (running) {
    label = t("evolving");
  } else if (data.error) {
    label = t("failed", { error: data.error });
  } else {
    const c = data.changes;
    const hasChanges =
      !!data.hasChanges &&
      !!c &&
      (c.added > 0 ||
        c.reinforced > 0 ||
        c.demoted > 0 ||
        c.removed > 0 ||
        c.superseded > 0);
    if (!hasChanges) {
      label = t("noChanges");
    } else {
      const counts = [
        c.added > 0 && t("added", { count: c.added }),
        c.reinforced > 0 && t("reinforced", { count: c.reinforced }),
        c.demoted > 0 && t("demoted", { count: c.demoted }),
        c.removed > 0 && t("removed", { count: c.removed }),
        c.superseded > 0 && t("superseded", { count: c.superseded }),
      ]
        .filter(Boolean)
        .join(" · ");
      // The agent's own one-sentence account is the headline when present;
      // the abstract line counts are the fallback.
      label = t("evolved", { summary: data.summary?.trim() || counts });
    }
    // A partial run applied only part of its update — flag it on the headline.
    if (data.partial) label += ` ${t("partial")}`;
  }

  const state: ToolRenderState = {
    running,
    inputStreaming: false,
    interrupted: false,
    denied: false,
    approvalRequested: false,
    isActiveApproval: false,
    error: !running ? data.error : undefined,
  };

  const stepText =
    data.step === "reading"
      ? t("reading")
      : data.step === "reviewing"
        ? t("reviewing")
        : data.step === "applied"
          ? t("applied")
          : undefined;

  return (
    <PhaseIndicator
      mode="streaming"
      className={running ? "bg-brand-50/50 dark:bg-brand-500/[0.06]" : undefined}
      icon={<Sparkles className="h-3.5 w-3.5" />}
      label={label}
      state={state}
      // The realtime thinking line is the subtitle; the coarse step wording is
      // the fallback until the first live line arrives.
      streamingText={data.live ?? (running ? stepText : undefined)}
      subtitleTone={progressStageTone(data.liveStage)}
      expandedContent={running ? undefined : <EvolutionDetail data={data} />}
    />
  );
}
