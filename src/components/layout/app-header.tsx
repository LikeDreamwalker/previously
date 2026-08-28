"use client";

import { Link } from "@/i18n/navigation";
import { BookOpen } from "lucide-react";
import { useLocale } from "next-intl";
import { ThemeToggle } from "@/components/chat/theme-toggle";
import { LocaleToggle } from "@/components/chat/locale-toggle";
import { VersionBadge } from "@/components/layout/version-badge";
import { DemoBadge } from "@/components/layout/demo-badge";
import { ClientBadge } from "@/components/layout/client-badge";
import { SettingsLink } from "@/components/layout/settings-link";

export function AppHeader({ isDemo = false }: { isDemo?: boolean }) {
  const locale = useLocale();

  return (
    <header className="fixed top-0 inset-x-0 z-50 flex items-center justify-between h-12 px-4 sm:px-6 bg-background/90 backdrop-blur-md">
      <div className="flex items-center gap-1">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight hover:text-foreground/80 transition-colors"
        >
          Previously
        </Link>
      </div>

      <nav className="flex items-center gap-1">
        {isDemo && <DemoBadge />}
        <ClientBadge />
        <a
          href="https://github.com/previously-lab/agent"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          <span className="hidden sm:inline">GitHub</span>
        </a>
        <a
          href={`https://previously.ldwid.com/${locale}/docs`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">Docs</span>
        </a>
        <SettingsLink />

        <span className="w-px h-4 bg-border/50 mx-1" />
        <ThemeToggle />
        <LocaleToggle />
        <VersionBadge />
      </nav>
    </header>
  );
}
