"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { saveUserConfig } from "@/lib/config/actions";
import { checkForUpdate, type UpdateInfo } from "@/lib/version/actions";
import { syncFromUpstream, type SyncResult } from "@/lib/version/sync";
import { APP_VERSION } from "@/lib/version/constants";
import type { UserConfig } from "@/lib/config/types";

export function SettingsForm({
  initialConfig,
  dataSource = "local",
  canWrite = true,
}: {
  initialConfig: UserConfig;
  dataSource?: string;
  canWrite?: boolean;
}) {
  const t = useTranslations("settings");
  const isDemo = dataSource === "demo";

  // ── Config (server-backed: memory/user/config.json) ──
  const [maxTurnsPerSlice, setMaxTurnsPerSlice] = useState(initialConfig.slicing.maxTurnsPerSlice);
  const [timeSilenceMinutes, setTimeSilenceMinutes] = useState(initialConfig.slicing.timeSilenceMinutes);
  const [recentTurnsLimit, setRecentTurnsLimit] = useState(initialConfig.context.recentTurnsLimit);
  const [tokenBudget, setTokenBudget] = useState(initialConfig.context.tokenBudget);
  const [modelProvider, setModelProvider] = useState(initialConfig.model.provider);
  const [modelThinking, setModelThinking] = useState(initialConfig.model.thinking);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSavedMsg, setConfigSavedMsg] = useState("");

  const handleConfigSave = async () => {
    setConfigSaving(true);
    setConfigSavedMsg("");
    const res = await saveUserConfig({
      slicing: { maxTurnsPerSlice, timeSilenceMinutes },
      context: { recentTurnsLimit, tokenBudget },
      model: { provider: modelProvider, thinking: modelThinking, reasoningEffort: "medium" as const },
    });
    setConfigSaving(false);
    setConfigSavedMsg(res.ok ? t("config.saved") : t("config.saveFailed"));
    if (res.ok) setTimeout(() => setConfigSavedMsg(""), 2500);
  };

  const inputClass =
    "w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
  const numberInputClass =
    "w-24 px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-8">
      {/* Data source — demo info banner */}
      {isDemo && (
        <section className="rounded-lg border border-border p-4 bg-muted/20">
          <h3 className="text-sm font-medium mb-1">{t("demo.heading")}</h3>
          <p className="text-xs text-muted-foreground">{t("demo.description")}</p>
          <a
            href="https://previously.ldwid.com/docs/deployment"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-xs text-primary hover:underline"
          >
            {t("demo.setupLink")}
          </a>
        </section>
      )}

      {/* Config — tunable agent behaviour (memory/user/config.json) */}
      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-1">{t("config.heading")}</h3>
        <p className="text-xs text-muted-foreground mb-4">{t("config.desc")}</p>
        <div className="space-y-4">
          {/* Slicing */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.maxTurnsPerSlice")}</span>
              <input type="number" min={5} max={100} value={maxTurnsPerSlice} onChange={(e) => setMaxTurnsPerSlice(Number(e.target.value))} className={numberInputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.timeSilenceMinutes")}</span>
              <input type="number" min={5} max={120} value={timeSilenceMinutes} onChange={(e) => setTimeSilenceMinutes(Number(e.target.value))} className={numberInputClass} />
            </label>
          </div>
          {/* Context */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.recentTurnsLimit")}</span>
              <input type="number" min={3} max={60} value={recentTurnsLimit} onChange={(e) => setRecentTurnsLimit(Number(e.target.value))} className={numberInputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.tokenBudget")}</span>
              <input type="number" min={2000} max={64000} step={1000} value={tokenBudget} onChange={(e) => setTokenBudget(Number(e.target.value))} className={numberInputClass} />
            </label>
          </div>
          {/* Model */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("config.modelProvider")}</span>
              <select value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} className={inputClass}>
                <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                <option value="deepseek-v4-pro">deepseek-v4-pro</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-2">
              <input type="checkbox" checked={modelThinking} onChange={(e) => setModelThinking(e.target.checked)} className="h-4 w-4" />
              <span className="text-xs text-muted-foreground">{t("config.thinking")}</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={handleConfigSave} disabled={configSaving || !canWrite} title={!canWrite ? "Unavailable in demo mode" : undefined}>
              {configSaving ? t("config.saving") : t("config.save")}
            </Button>
            {configSavedMsg && <span className="text-xs text-muted-foreground">{configSavedMsg}</span>}
          </div>
        </div>
      </section>

      {/* Version */}
      <VersionSection />

    </div>
  );
}

function VersionSection() {
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
      setSyncError(
        e instanceof Error ? e.message : "An unexpected error occurred during sync.",
      );
    }
    setSyncing(false);
  };

  useEffect(() => { doCheck(); }, []);

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium mb-1">{t("version.heading")}</h3>
      <p className="text-xs text-muted-foreground">
        v{APP_VERSION}
        {info?.updateAvailable && info.latest && (
          <span className="ml-2 text-red-500">{t("version.updateAvailable", { version: info.latest })}</span>
        )}
        {info && !info.updateAvailable && (
          <span className="ml-2 text-muted-foreground/60">{t("version.upToDate")}</span>
        )}
      </p>

      {/* Check button */}
      <div className="flex items-center gap-3 mt-3">
        <Button onClick={doCheck} disabled={checking} variant="secondary" className="text-xs">
          {checking ? t("version.checking") : t("version.checkButton")}
        </Button>
      </div>

      {/* Sync section — only show when update is available */}
      {info?.updateAvailable && (
        <div className="mt-4 pt-4 border-t border-border">
          <h4 className="text-sm font-medium mb-1">{t("version.sync.heading")}</h4>
          <p className="text-xs text-muted-foreground mb-3">
            {t("version.sync.desc")}
          </p>

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
            <p className="mt-2 text-xs text-green-600 dark:text-green-400">
              {syncResult.syncedFiles === 0
                ? t("version.sync.noChanges")
                : t("version.sync.success", { count: syncResult.syncedFiles ?? 0, version: syncResult.upstreamVersion ?? "latest" })}
            </p>
          )}

          {/* Error */}
          {syncError && (
            <p className="mt-2 text-xs text-red-500">{syncError}</p>
          )}
        </div>
      )}
    </section>
  );
}
