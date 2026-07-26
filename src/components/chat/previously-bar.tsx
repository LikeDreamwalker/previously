"use client";

import { Brain, Loader2 } from "lucide-react";
import type { EvolutionState } from "./evolution-indicator";

// ─── Types ──────────────────────────────────────────────────────────────

interface PreviouslyBarProps {
  evolutionState?: EvolutionState | null;
}

// ─── Mutation summary helpers ────────────────────────────────────────────

const CHANGE_LABELS: Array<{ key: string; label: string; emoji: string }> = [
  { key: "added", label: "新增", emoji: "+" },
  { key: "reinforced", label: "强化", emoji: "↑" },
  { key: "demoted", label: "降级", emoji: "↓" },
  { key: "removed", label: "删除", emoji: "✕" },
  { key: "superseded", label: "取代", emoji: "↻" },
];

function changeSummary(
  changes: EvolutionState["changes"],
): string | null {
  if (!changes) return null;
  const parts = CHANGE_LABELS
    .filter((c) => (changes as Record<string, number>)[c.key] > 0)
    .map((c) => `${c.emoji}${(changes as Record<string, number>)[c.key]} ${c.label}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ─── Component ──────────────────────────────────────────────────────────

export function PreviouslyBar({ evolutionState }: PreviouslyBarProps) {
  // Nothing to show
  if (!evolutionState) return null;

  const { running, step, changes, error } = evolutionState;

  // ── Running ──────────────────────────────────────────────────────────
  if (running) {
    const subtitle =
      step === "reading"
        ? "正在读取记忆..."
        : step === "reviewing"
          ? "正在审查对话模式..."
          : undefined;

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground border-t border-border/50 bg-muted/30">
        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        <Brain className="h-3 w-3 shrink-0" />
        <span className="font-medium">自进化中…</span>
        {subtitle && <span className="opacity-60">{subtitle}</span>}
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-destructive border-t border-border/50 bg-destructive/5">
        <Brain className="h-3 w-3 shrink-0" />
        <span>自进化失败: {error}</span>
      </div>
    );
  }

  // ── Complete, no changes ─────────────────────────────────────────────
  const summary = changeSummary(changes);
  if (!summary) {
    // Show a minimal indicator — checked, nothing to report
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-[0.65rem] text-muted-foreground/50 border-t border-border/30 bg-muted/20">
        <Brain className="h-2.5 w-2.5 shrink-0" />
        <span>已检查</span>
      </div>
    );
  }

  // ── Complete, has changes ────────────────────────────────────────────
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-t border-border/50 bg-muted/30">
      <Brain className="h-3 w-3 shrink-0 text-foreground/70" />
      <span className="font-medium text-foreground/80">已进化：</span>
      <span className="text-muted-foreground">{summary}</span>
    </div>
  );
}
