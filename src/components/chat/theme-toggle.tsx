"use client";

import { useEffect, useState } from "react";
import { useTheme } from '@teispace/next-themes';
import { useTranslations } from "next-intl";
import { Sun, Moon, Monitor } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ORDER = ["light", "dark", "system"] as const;

/** Small toolbar button that cycles light → dark → system. */
export function ThemeToggle() {
  const t = useTranslations("theme");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = (theme ?? "system") as (typeof ORDER)[number];
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;

  const cycle = () => {
    const idx = ORDER.indexOf(current);
    setTheme(ORDER[(idx + 1) % ORDER.length]);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={cycle}
            aria-label={t("toggleTooltip")}
            className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center"
          >
            {/* Stable icon pre-mount to avoid hydration mismatch */}
            {mounted ? <Icon className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
          </button>
        }
      />
      <TooltipContent side="top">
        {mounted ? t(current) : t("toggleTooltip")}
      </TooltipContent>
    </Tooltip>
  );
}
