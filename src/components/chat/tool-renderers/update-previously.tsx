"use client";

import { useTranslations } from "next-intl";
import { Brain } from "lucide-react";
import { PhaseIndicator } from "../phase-indicator";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import type { PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";

interface UpdatePreviouslyRendererProps {
  state: ToolRenderState;
  input?: unknown;
  output?: unknown;
}

const ACTION_COLORS: Record<PreviouslyMutation["action"], string> = {
  observe: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  reinforce: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  contradict: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  discard: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  expire: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  promote: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
  demote: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
};

const TIER_LABEL_KEYS: Record<PreviouslyMutation["tier"], string> = {
  long: "tierLong",
  short: "tierShort",
};

const SUBSECTION_LABEL_KEYS: Record<PreviouslyMutation["subsection"], string> = {
  identity: "subsectionIdentity",
  patterns: "subsectionPatterns",
  strategies: "subsectionStrategies",
  context: "subsectionContext",
};

/**
 * Renderer for the updatePreviously tool call.
 *
 * Collapsed: signal label + note header, counts as summary (e.g. "+2 added · ↑1 reinforced").
 * Expanded: color-coded list of each mutation showing what actually changed.
 */
export function UpdatePreviouslyRenderer({
  state,
  input,
  output,
}: UpdatePreviouslyRendererProps) {
  const t = useTranslations("chat.tool");

  const inputObj = input as { signal?: string; note?: string } | undefined;
  const outputObj = output as {
    acknowledged?: boolean;
    changes?: { added: number; reinforced: number; demoted: number; removed: number; superseded: number };
    mutations?: PreviouslyMutation[];
    error?: string;
  } | undefined;

  const signalLabels: Record<string, string> = {
    new_observation: t("signalNewObservation"),
    user_correction: t("signalUserCorrection"),
    slice_closed: t("signalSliceClosed"),
    self_reflection: t("signalSelfReflection"),
  };

  const signalLabel = inputObj?.signal
    ? (signalLabels[inputObj.signal] ?? inputObj.signal)
    : "";

  const isRunning = state.running;
  const hasError = !!outputObj?.error;

  const label = isRunning
    ? t("updatePreviously")
    : hasError
      ? `${signalLabel} — ${outputObj!.error}`
      : inputObj?.note
        ? `${signalLabel}: ${inputObj.note}`
        : signalLabel;

  const changes = outputObj?.changes;
  const hasChanges =
    changes &&
    (changes.added > 0 || changes.reinforced > 0 || changes.demoted > 0 || changes.removed > 0 || changes.superseded > 0);

  const summary = !isRunning && hasChanges
    ? [
        changes!.added > 0 && `+${changes!.added} ${t("added")}`,
        changes!.reinforced > 0 && `↑${changes!.reinforced} ${t("reinforced")}`,
        changes!.demoted > 0 && `↓${changes!.demoted} ${t("demoted")}`,
        changes!.removed > 0 && `✕${changes!.removed} ${t("removed")}`,
        changes!.superseded > 0 && `↻${changes!.superseded} ${t("superseded")}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  const meta = !isRunning && !hasError && !hasChanges ? "—" : undefined;

  const expandedContent = hasChanges && outputObj?.mutations ? (
    <div className="flex flex-col gap-1.5 text-xs">
      {outputObj.mutations.map((m, i) => (
        <div
          key={i}
          className={`rounded border px-2 py-1.5 ${ACTION_COLORS[m.action]}`}
        >
          <span className="font-semibold">
            {t(`action_${m.action}`)}
          </span>
          <span className="mx-1.5">—</span>
          <span className="break-all">
            {m.belief || m.belief_key || "(no text)"}
          </span>
          <span className="ml-2 opacity-60">
            {t(TIER_LABEL_KEYS[m.tier])} · {t(SUBSECTION_LABEL_KEYS[m.subsection])}
          </span>
          {m.note && (
            <span className="ml-2 opacity-50 italic">
              — {m.note}
            </span>
          )}
        </div>
      ))}
    </div>
  ) : undefined;

  return (
    <PhaseIndicator
      mode="static"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={label}
      summary={summary}
      meta={meta}
      state={state}
      expandedContent={expandedContent}
    />
  );
}
