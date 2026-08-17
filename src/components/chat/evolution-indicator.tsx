"use client";

import { Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "./phase-indicator";
import type { ToolRenderState } from "@/lib/chat/tool-state";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionState {
  running: boolean;
  step?: string;
  /** Card update summary: added = card rewritten, removed = stale Now items dropped. */
  changes?: {
    added: number;
    reinforced: number;
    demoted: number;
    removed: number;
    superseded: number;
  };
  hasChanges?: boolean;
  /** The review's reasoning — shown as the indicator's expanded content. */
  note?: string;
  /** The agent's one-sentence user-language account of what changed — the
   *  indicator's headline when present (the abstract counts fall back). */
  summary?: string;
  /** The actual line-level card mutations — the expanded diff. */
  mutations?: Array<{ type: "added" | "removed"; text: string }>;
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

  // The expanded body for the terminal states: the actual card diff (added /
  // removed lines) plus the reviewer's reasoning note. Its presence is what
  // makes the PhaseIndicator expandable at all (no expandedContent → the card
  // renders non-clickable by construction).
  const hasMutations = (state.mutations?.length ?? 0) > 0;
  const hasNote = Boolean(state.note?.trim());
  const expandedContent =
    hasMutations || hasNote ? (
      <div className="space-y-2">
        {hasMutations && (
          <ul className="space-y-1 font-mono text-xs leading-relaxed">
            {state.mutations!.map((m, i) => (
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
            {state.note}
          </p>
        )}
      </div>
    ) : undefined;

  // ── Running ──────────────────────────────────────────────────────────────

  if (state.running) {
    const subtitle =
      state.step === "reading"
        ? t("reading")
        : state.step === "reviewing"
          ? t("reviewing")
          : state.step === "applied"
            ? t("applied")
            : undefined;

    return (
      <PhaseIndicator
        mode="static"
        className="bg-brand-100/40 dark:bg-brand-400/[0.07]"
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
        expandedContent={expandedContent}
      />
    );
  }

  // ── Complete, has changes ────────────────────────────────────────────────

  const c = state.changes!;
  const counts = [
    c.added > 0 && t("added", { count: c.added }),
    c.reinforced > 0 && t("reinforced", { count: c.reinforced }),
    c.demoted > 0 && t("demoted", { count: c.demoted }),
    c.removed > 0 && t("removed", { count: c.removed }),
    c.superseded > 0 && t("superseded", { count: c.superseded }),
  ]
    .filter(Boolean)
    .join(" · ");

  // The agent's own one-sentence account is the headline when present; the
  // abstract line counts demote to the meta line (and remain the fallback
  // headline when the worker gave no summary).
  return (
    <PhaseIndicator
      mode="static"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={t("evolved", { summary: state.summary?.trim() || counts })}
      meta={state.summary?.trim() ? counts : undefined}
      state={COMPLETED_STATE}
      expandedContent={expandedContent}
    />
  );
}
