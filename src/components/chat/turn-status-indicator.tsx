"use client";

import { useTranslations } from "next-intl";
import { Loader2, Check, AlertTriangle, XCircle, Brain, Sparkles } from "lucide-react";
import type { TurnStatus } from "@/lib/chat/turn-types";

const STATUS_ICONS: Record<TurnStatus, React.ReactNode> = {
  active: <Loader2 className="h-3 w-3 animate-spin" />,
  thinking: <Brain className="h-3 w-3 animate-pulse" />,
  synthesizing: <Sparkles className="h-3 w-3 animate-pulse" />,
  done: <Check className="h-3 w-3" />,
  interrupted: <AlertTriangle className="h-3 w-3" />,
  error: <XCircle className="h-3 w-3" />,
};

/**
 * Layer 2 turn-status pill — sits above the chat input. Shows the durable
 * turn lifecycle: spinning while the LLM works, a checkmark when done, and a
 * Continue affordance when the turn was interrupted. Driven by the
 * `data-turn-status` part the workflow's finalizeTurn step emits (and reset to
 * "active" whenever a new turn starts streaming).
 */
export function TurnStatusIndicator({
  status,
  onContinue,
}: {
  status: TurnStatus;
  onContinue?: () => void;
}) {
  const t = useTranslations("chat.turnStatus");
  const isInterrupted = status === "interrupted";

  return (
    <div className="flex items-center justify-center gap-2">
      <div
        className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground"
        title={isInterrupted ? t("interruptedHint") : undefined}
      >
        {STATUS_ICONS[status]}
        <span>{t(status)}</span>
      </div>
      {isInterrupted && onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted-foreground/10"
        >
          {t("interruptedContinue")}
        </button>
      )}
    </div>
  );
}
