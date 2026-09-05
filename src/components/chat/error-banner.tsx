"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

/**
 * The red chat-error banner. The `error` object carries far more than `.message`
 * (name / stack / cause / statusCode), so render the full detail in an
 * expandable block AND log it — the minified production message alone is not
 * enough to locate the fault.
 */
export function ErrorBanner({ error }: { error: Error }): ReactNode {
  const t = useTranslations("errorBoundary");
  useEffect(() => {
    console.error("[Chat][error banner]", formatErrorDetail(error));
  }, [error]);
  return (
    <div className="mx-4 my-2 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <div className="font-medium">{error.message}</div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs opacity-80">
          {t("fullError")}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/20 bg-background p-2 font-mono text-xs leading-relaxed">
          {formatErrorDetail(error)}
        </pre>
      </details>
    </div>
  );
}
