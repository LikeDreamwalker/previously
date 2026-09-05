"use client";

/**
 * Degraded views for the 3D timeline: a spinner while the scene chunk loads,
 * a notice for an empty catalog, and — when WebGL is unavailable — the
 * existing TimelineWheel as the precise fallback view
 * (doc/design/v0.10.0-memory-viz.md §5.3). The wheel is used controlled:
 * nothing is "loaded" on this route (selectedId=null) and selecting a row
 * routes back to the chat at that slice (`/?at=<sliceId>`), matching the
 * §5.4 plan for the wheel's selection chain.
 */
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { TimelineWheel } from "@/components/chat/timeline-wheel";

export type TimelineFallbackState = "loading" | "unsupported" | "empty";

export function TimelineFallback({ state }: { state: TimelineFallbackState }) {
  const t = useTranslations("timeline3d.fallback");

  if (state === "unsupported") return <WheelFallback />;

  return (
    <div className="flex h-full w-full items-center justify-center gap-2 bg-background px-6 text-center text-sm text-muted-foreground">
      {state === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
      {t(state)}
    </div>
  );
}

function WheelFallback() {
  const t = useTranslations("timeline3d.fallback");
  const router = useRouter();
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <p className="shrink-0 px-6 pb-2 pt-5 text-center text-sm text-muted-foreground">
        {t("unsupported")}
      </p>
      <div className="min-h-0 flex-1 px-6 pb-4">
        <div className="mx-auto h-full max-w-xs">
          <TimelineWheel
            selectedId={null}
            onSelect={(sliceId) =>
              router.push(sliceId === "now" ? "/" : `/?at=${sliceId}`)
            }
          />
        </div>
      </div>
    </div>
  );
}
