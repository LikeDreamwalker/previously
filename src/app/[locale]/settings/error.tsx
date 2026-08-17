"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("settings.error");
  const tCommon = useTranslations("common");

  useEffect(() => {
    console.error("[RouteError][settings]", formatErrorDetail(error), error);
  }, [error]);

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-2xl">
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
