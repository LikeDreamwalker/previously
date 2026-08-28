"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Client-mode header badge — mirrors DemoBadge visually, but gates at
 * RUNTIME via /api/version instead of a server-resolved prop (pages are
 * prerendered at build time, before PREVIOUSLY_MODE is known — the same
 * fetch-and-self-hide pattern as the settings Client section). Renders
 * nothing until the probe resolves; when mode is not "client" the badge
 * never appears at all.
 *
 * Build-time escape hatch: cloud builds set NEXT_PUBLIC_PREVIOUSLY_TARGET=cloud,
 * so the bundler dead-code-eliminates this component out of the browser
 * bundle. The kernel packaging build (pnpm build:standalone) sets it to
 * "client"; unset keeps the runtime-gated behavior for local dev.
 */
const IS_CLOUD_BUILD = process.env.NEXT_PUBLIC_PREVIOUSLY_TARGET === "cloud";

interface VersionInfo {
  version: string;
  mode: string;
}

export function ClientBadge() {
  const t = useTranslations("clientBadge");
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    if (IS_CLOUD_BUILD) return;
    let cancelled = false;
    (async () => {
      try {
        // Runtime mode check — the page was prerendered before mode was known.
        const res = await fetch("/api/version");
        if (!res.ok) return;
        const data = (await res.json()) as VersionInfo;
        if (!cancelled && data.mode === "client") setInfo(data);
      } catch {
        // Unreachable API — the badge stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (IS_CLOUD_BUILD || !info) return null;

  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer">
        {t("badgeLabel")}
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm">
        <div className="space-y-2">
          <p className="font-medium">{t("badgeTitle")}</p>
          <p className="text-muted-foreground text-xs">{t("badgeDesc")}</p>
          <p className="text-muted-foreground/70 text-xs">
            {t("versionLabel")}: v{info.version}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
