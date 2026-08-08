"use client";

import { Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "./phase-indicator";
import type { ToolRenderState } from "@/lib/chat/tool-state";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionState {
  running: boolean;
  step?: string;
  /** Card update summary: added = card rewritten, removed = stale Recent dropped. */
  changes?: {
    added: number;
    reinforced: number;
    demoted: number;
    removed: number;
    superseded: number;
  };
  hasChanges?: boolean;
  error?: string;
}

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
    !!state.hasChanges &&
    !!state.changes &&
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

  const c = state.changes!;
  const summary = [
    c.added > 0 && t("added", { count: c.added }),
    c.reinforced > 0 && t("reinforced", { count: c.reinforced }),
    c.demoted > 0 && t("demoted", { count: c.demoted }),
    c.removed > 0 && t("removed", { count: c.removed }),
    c.superseded > 0 && t("superseded", { count: c.superseded }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PhaseIndicator
      mode="static"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={t("evolved", { summary })}
      state={COMPLETED_STATE}
    />
  );
}
