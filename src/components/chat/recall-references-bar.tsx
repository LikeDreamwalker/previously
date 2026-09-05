"use client";

import { useLocale, useTranslations } from "next-intl";
import { History } from "lucide-react";
import type { RecallReferenceAnchor } from "@/lib/chat/build-stream";
import { requestSliceJump } from "@/lib/chat/slice-jump";
import { formatSliceIdLabel } from "@/lib/chat/slice-id-time";

/** How many slice chips render before the rest collapse into the count. */
const MAX_CHIPS = 3;

/**
 * The "referenced N time slices" bar under an agent reply (v0.10 §4.1) — the
 * evidence anchors of the turn's recall calls, made visible and clickable.
 * Clicking a chip jumps the unified message stream to that slice (the same
 * page-until-loaded + scroll-to-seam path as the search palette). The full
 * quotes stay in the recall tool card; this bar answers "which of my memories
 * is the agent using right now".
 */
export function RecallReferencesBar({
  references,
}: {
  references: RecallReferenceAnchor[];
}) {
  const t = useTranslations("chat.references");
  const locale = useLocale();
  if (references.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 pt-1 text-xs text-muted-foreground">
      <History className="h-3 w-3 shrink-0" />
      <span>{t("title", { count: references.length })}</span>
      {references.slice(0, MAX_CHIPS).map((r) => (
        <button
          key={r.slice_id}
          type="button"
          title={r.note || undefined}
          onClick={() => requestSliceJump(r.slice_id)}
          className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground transition-colors hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
        >
          {formatSliceIdLabel(r.slice_id, locale) || r.slice_id}
        </button>
      ))}
    </div>
  );
}
