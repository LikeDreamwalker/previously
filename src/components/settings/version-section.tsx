"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { checkForUpdate, type UpdateInfo } from "@/lib/version/actions";
import { syncFromUpstream, type SyncResult } from "@/lib/version/sync";
import { APP_VERSION } from "@/lib/version/constants";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

/**
 * Version & upstream-sync block — cloud mode only (the settings page gates on
 * isClientMode(); a client kernel upgrades via the client CLI instead).
 */
export function VersionSection() {
  const t = useTranslations("settings");

  // ── Version check ──
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);

  // ── Sync ──
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const doCheck = async () => {
    setChecking(true);
    try {
      const result = await checkForUpdate();
      setInfo(result);
    } catch { /* ignore */ }
    setChecking(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const result = await syncFromUpstream();
      if (result.ok) {
        setSyncResult(result);
        // Refresh version info after successful sync
        setInfo(null);
        doCheck();
      } else {
        setSyncError(result.error ?? "Sync failed. Please try again.");
      }
    } catch (e) {
      console.error("[VersionSection] sync failed:", formatErrorDetail(e));
      setSyncError(
        e instanceof Error ? e.message : "An unexpected error occurred during sync.",
      );
    }
    setSyncing(false);
  };

  useEffect(() => { doCheck(); }, []);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium">{t("version.heading")}</h3>
        <p className="text-sm text-muted-foreground">
          v{APP_VERSION}
          {info?.updateAvailable && info.latest && (
            <span className="ml-2 text-red-500">{t("version.updateAvailable", { version: info.latest })}</span>
          )}
          {info && !info.updateAvailable && (
            <span className="ml-2 text-muted-foreground/60">{t("version.upToDate")}</span>
          )}
        </p>
      </div>

      {/* Check button */}
      <div className="flex items-center gap-3">
        <Button onClick={doCheck} disabled={checking} variant="secondary" className="text-xs">
          {checking ? t("version.checking") : t("version.checkButton")}
        </Button>
      </div>

      {/* Sync section — only show when update is available */}
      {info?.updateAvailable && (
        <div className="space-y-3">
          <Separator />
          <div className="space-y-1">
            <h4 className="text-sm font-medium">{t("version.sync.heading")}</h4>
            <p className="text-sm text-muted-foreground">
              {t("version.sync.desc")}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={handleSync}
              disabled={syncing}
              className="text-xs"
            >
              {syncing ? t("version.sync.syncing") : t("version.sync.button")}
            </Button>
          </div>

          {/* Success */}
          {syncResult && syncResult.ok && (
            <p className="text-xs text-green-600 dark:text-green-400">
              {syncResult.syncedFiles === 0
                ? t("version.sync.noChanges")
                : t("version.sync.success", { count: syncResult.syncedFiles ?? 0, version: syncResult.upstreamVersion ?? "latest" })}
            </p>
          )}

          {/* Error */}
          {syncError && (
            <p className="text-xs text-red-500">{syncError}</p>
          )}
        </div>
      )}
    </section>
  );
}
