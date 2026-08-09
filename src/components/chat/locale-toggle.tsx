"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Small toolbar button that swaps the UI language (en ⇄ zh) via the URL locale. */
export function LocaleToggle() {
  const t = useTranslations("locale");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const next = locale === "zh" ? "en" : "zh";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => router.replace(pathname, { locale: next })}
            aria-label={t("switchTooltip")}
            className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center text-[11px] font-semibold"
          >
            {locale === "zh" ? "中" : "EN"}
          </button>
        }
      />
      <TooltipContent side="top">{t("switchTooltip")}</TooltipContent>
    </Tooltip>
  );
}
