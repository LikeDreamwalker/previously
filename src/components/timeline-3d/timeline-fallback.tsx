"use client";

/**
 * Loading shell for the timeline route — shown while the client checks WebGL
 * support (Rev 8 §R8: without WebGL the ambient strip simply drops out and
 * the stack list takes the full width, so there is no degraded data view
 * anymore; the list itself renders its own empty state).
 */
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

export function TimelineFallback() {
  const t = useTranslations("timeline3d.fallback");
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 bg-background px-6 text-center text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {t("loading")}
    </div>
  );
}
