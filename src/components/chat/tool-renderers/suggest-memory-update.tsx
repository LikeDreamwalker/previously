"use client";

import { useState } from "react";
import { Brain, Check, X } from "lucide-react";
import { useTranslations } from "next-intl";

interface SuggestMemoryUpdateRendererProps {
  input?: { summary?: string };
  output?: { ok?: boolean; status?: string; summary?: string };
  state: { running: boolean; inputStreaming: boolean };
}

/**
 * Interactive confirm bubble for the `suggestMemoryUpdate` tool.
 *
 * The model calls it when the user expresses a durable preference / correction.
 * It is a PURE TRIGGER: confirm fires the evolution workflow (user_correction)
 * and the pipeline produces the neutral result — no content editing here.
 */
export function SuggestMemoryUpdateRenderer({
  input,
  output,
  state,
}: SuggestMemoryUpdateRendererProps) {
  const t = useTranslations("chat.tool.suggestMemoryUpdate");
  const [result, setResult] = useState<"confirmed" | "cancelled" | null>(null);
  const [busy, setBusy] = useState(false);

  const summary = output?.summary ?? input?.summary ?? "";

  if (state.running || state.inputStreaming) {
    return (
      <div className="rounded-xl border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t("detecting")}
      </div>
    );
  }

  if (result === "confirmed") {
    return (
      <div className="rounded-xl border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Brain className="mr-1.5 inline h-3.5 w-3.5" />
        {t("confirmed")}
      </div>
    );
  }
  if (result === "cancelled") {
    return (
      <div className="rounded-xl border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t("cancelled")}
      </div>
    );
  }

  const confirm = async () => {
    setBusy(true);
    try {
      await fetch("/api/evolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "user_correction" }),
      });
      setResult("confirmed");
    } catch {
      setResult("cancelled");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border bg-muted/50 p-3">
      <div className="flex items-start gap-2">
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-foreground/70" />
        <div className="min-w-0 text-sm">
          <div className="font-medium">{t("title")}</div>
          {summary && (
            <div className="mt-0.5 break-words text-xs text-muted-foreground">
              <span className="opacity-60">{t("summary")}</span> {summary}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              <Check className="h-3 w-3" />
              {busy ? t("running") : t("confirm")}
            </button>
            <button
              type="button"
              onClick={() => setResult("cancelled")}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
            >
              <X className="h-3 w-3" />
              {t("cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
