"use client";

import { Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "./phase-indicator";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import type { PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionState {
  running: boolean;
  step?: string;
  changes?: {
    added: number;
    reinforced: number;
    demoted: number;
    removed: number;
    superseded: number;
  };
  mutations?: PreviouslyMutation[];
  hasChanges?: boolean;
  error?: string;
}

// ─── Color constants ────────────────────────────────────────────────────

const ACTION_COLORS: Record<PreviouslyMutation["action"], string> = {
  observe: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  reinforce: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  contradict: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  discard: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  expire: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  promote: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
  demote: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
};

// ─── Component ──────────────────────────────────────────────────────────────

interface EvolutionIndicatorProps {
  state: EvolutionState | null | undefined;
}

const RUNNING_STATE: ToolRenderState = {
  running: true,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const COMPLETED_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const ERROR_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: false,
  denied: true,
  approvalRequested: false,
  isActiveApproval: false,
};

export function EvolutionIndicator({ state }: EvolutionIndicatorProps) {
  const t = useTranslations("chat.evolution");

  if (!state || (!state.running && !state.changes && !state.error)) {
    return null;
  }

  // ── Running ──────────────────────────────────────────────────────────────

  if (state.running) {
    const subtitle =
      state.step === "reading"
        ? t("reading")
        : state.step === "reviewing"
          ? t("reviewing")
          : undefined;

    return (
      <PhaseIndicator
        mode="static"
        icon={<Brain className="h-3.5 w-3.5" />}
        label={t("evolving")}
        summary={subtitle}
        state={RUNNING_STATE}
      />
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────

  if (state.error) {
    return (
      <PhaseIndicator
        mode="static"
        icon={<Brain className="h-3.5 w-3.5" />}
        label={t("failed", { error: state.error })}
        state={ERROR_STATE}
      />
    );
  }

  // ── Complete, no changes ─────────────────────────────────────────────────

  const hasChanges =
    state.hasChanges &&
    state.changes &&
    (state.changes.added > 0 ||
      state.changes.reinforced > 0 ||
      state.changes.demoted > 0 ||
      state.changes.removed > 0 ||
      state.changes.superseded > 0);

  if (!hasChanges) {
    return (
      <PhaseIndicator
        mode="static"
        icon={<Brain className="h-3.5 w-3.5" />}
        label={t("noChanges")}
        meta={t("noChangesMeta")}
        state={COMPLETED_STATE}
      />
    );
  }

  // ── Complete, has changes ────────────────────────────────────────────────

  const summary = [
    state.changes!.added > 0 && t("added", { count: state.changes!.added }),
    state.changes!.reinforced > 0 && t("reinforced", { count: state.changes!.reinforced }),
    state.changes!.demoted > 0 && t("demoted", { count: state.changes!.demoted }),
    state.changes!.removed > 0 && t("removed", { count: state.changes!.removed }),
    state.changes!.superseded > 0 && t("superseded", { count: state.changes!.superseded }),
  ]
    .filter(Boolean)
    .join(" · ");

  const expandedContent = state.mutations && state.mutations.length > 0 && (
    <div className="flex flex-col gap-1.5 text-xs">
      {state.mutations.map((m, i) => (
        <div
          key={i}
          className={`rounded border px-2 py-1.5 ${ACTION_COLORS[m.action]}`}
        >
          <span className="font-semibold">{t(`action_${m.action}`)}</span>
          <span className="mx-1.5">—</span>
          <span className="break-all">
            {m.belief || m.belief_key || "(no text)"}
          </span>
          <span className="ml-2 opacity-60">
            {t(`tier_${m.tier}`)} · {t(`subsection_${m.subsection}`)}
          </span>
          {m.note && (
            <span className="ml-2 opacity-50 italic">— {m.note}</span>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <PhaseIndicator
      mode="static"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={t("evolved", { summary })}
      state={COMPLETED_STATE}
      expandedContent={expandedContent}
    />
  );
}
