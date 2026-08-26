"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTurnBusy } from "@/components/chat/turn-busy";

/**
 * Header entry to /settings. Disabled while a chat turn is in flight —
 * engine/model settings saved mid-turn would hot-apply to the next call, so
 * the entry is shielded until the current reply finishes.
 */
export function SettingsLink() {
  const t = useTranslations("nav");
  const busy = useTurnBusy();

  if (busy) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-disabled="true"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/50 cursor-not-allowed"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t("settings")}</span>
            </span>
          }
        />
        <TooltipContent side="bottom">{t("settingsBusy")}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      href="/settings"
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
    >
      <Settings className="h-3.5 w-3.5 shrink-0" />
      <span className="hidden sm:inline">{t("settings")}</span>
    </Link>
  );
}
