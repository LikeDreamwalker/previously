"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

/**
 * Route-level error boundary for the locale segment (chat / settings). Catches
 * render errors that escape the component-level boundaries (e.g. React's
 * minified #185 render loop) and surfaces the FULL error detail — name / stack /
 * cause — plus a full console.error, instead of the opaque production frame.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorBoundary");
  const tCommon = useTranslations("common");

  useEffect(() => {
    console.error("[RouteError][locale]", formatErrorDetail(error), error);
  }, [error]);

  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-2xl text-center">
        <AlertCircle className="h-8 w-8 mx-auto mb-3 text-destructive" />
        <h2 className="font-semibold mb-1">{t("title")}</h2>
        <pre className="mx-auto my-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 text-left font-mono text-xs leading-relaxed">
          {formatErrorDetail(error)}
        </pre>
        <Button variant="outline" onClick={reset}>
          {tCommon("retry")}
        </Button>
      </div>
    </div>
  );
}
