"use client";

import { useLocale, useTranslations } from "next-intl";
import type { SeamKind } from "@/lib/chat/seam";

/** Localized short date for seam headings / banners ("2月10日" / "Feb 10"). */
export function formatSeamDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/**
 * The seam between two slices in the unified stream (design §1.4).
 *
 * - `checkpoint` (time_cap / capacity close): a hairline with a whisper of
 *   text — the same conversation continued across an autosave boundary, so
 *   the seam must not interrupt reading.
 * - `boundary` (idle_gap / context_lost / unknown): a strong divider with a
 *   date heading — a genuine new conversation and a natural time bookmark.
 */
export function SliceSeam({ seam, dateIso }: { seam: SeamKind; dateIso: string }) {
  const t = useTranslations("chat.seam");
  const locale = useLocale();

  if (seam === "checkpoint") {
    return (
      <div className="my-3 flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-border/40" />
        <span className="shrink-0 text-[0.6rem] text-muted-foreground/50">
          {t("checkpoint")}
        </span>
        <span className="h-px flex-1 bg-border/40" />
      </div>
    );
  }

  return (
    <div className="my-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[0.65rem] font-medium text-muted-foreground">
        {t("newConversation", { date: formatSeamDate(dateIso, locale) })}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
