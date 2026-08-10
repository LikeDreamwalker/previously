"use client";

import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { ExternalLink } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { checkForUpdate, type UpdateInfo } from "@/lib/version/actions";
import { APP_VERSION } from "@/lib/version/constants";

export function VersionBadge() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    checkForUpdate().then(setInfo).catch(() => {});
  }, []);

  const trigger = (
    <button
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      title={`v${APP_VERSION}`}
    >
      v{APP_VERSION}
      {info?.updateAvailable && (
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      )}
    </button>
  );

  if (!info) return trigger;

  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-56 p-3 text-xs"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Current</span>
            <span className="font-mono font-medium">v{info.current}</span>
          </div>

          {info.updateAvailable && info.latest ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Latest</span>
                <span className="font-mono font-medium text-green-600 dark:text-green-400">v{info.latest}</span>
              </div>
              <hr className="border-border" />
              <Link
                href="https://github.com/previously-lab/agent/releases"
                target="_blank"
                className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400 hover:underline w-full"
              >
                View release notes
                <ExternalLink className="h-3 w-3" />
              </Link>
              <Link
                href={info.docsUrl}
                target="_blank"
                className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400 hover:underline w-full"
              >
                How to sync
                <ExternalLink className="h-3 w-3" />
              </Link>
              <p className="text-muted-foreground/70 text-[10px] leading-snug">
                Go to Settings → Sync from upstream to pull the latest code.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">You&apos;re on the latest version.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
