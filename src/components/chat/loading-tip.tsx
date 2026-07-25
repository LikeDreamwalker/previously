"use client";

import { useTranslations } from "next-intl";

/**
 * Minimal loading indicator — a simple "Thinking…" label with a subtle
 * pulse animation. No spinner (it clashes visually with tool-call spinners)
 * and no rotating tips carousel (the old implementation re-created its
 * sequence on every render when `useMessages()` returned a new reference
 * during streaming, causing rapid visual jitter).
 */
export function LoadingTip() {
  const t = useTranslations("chat.phase");

  return (
    <span className="animate-pulse text-xs text-muted-foreground">
      {t("thinking")}
    </span>
  );
}
