"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveUserConfig } from "@/lib/config/actions";
import type { SlicingConfig, UserConfig } from "@/lib/config/types";

/**
 * General settings (slicing knobs). Auto-saved: every edit schedules a
 * debounced saveUserConfig call (event-driven — a timer owned by the change
 * handlers, no state-watching effects) and a sonner toast reports the
 * outcome; there is no save button. "Restore defaults" resets just the
 * fields this form owns.
 */
export function SettingsForm({
  initialConfig,
  defaults,
  dataSource = "local",
  canWrite = true,
}: {
  initialConfig: UserConfig;
  /** Hard defaults for the fields this form owns (passed from the server —
   *  importing lib/config/defaults here would bundle the model registry). */
  defaults: SlicingConfig;
  dataSource?: string;
  canWrite?: boolean;
}) {
  const t = useTranslations("settings");
  const isDemo = dataSource === "demo";

  // ── Config (server-backed: memory/user/config.json) ──
  const [maxTurnsPerSlice, setMaxTurnsPerSlice] = useState(initialConfig.slicing.maxTurnsPerSlice);
  const [maxSliceMinutes, setMaxSliceMinutes] = useState(initialConfig.slicing.maxSliceMinutes);
  const [idleGapMinutes, setIdleGapMinutes] = useState(initialConfig.slicing.idleGapMinutes);

  // Toast messages are read through refs so the timer closure never goes
  // stale and nothing here needs an effect dependency on `t`.
  const tRef = useRef(t);
  tRef.current = t;

  // The debounce timer lives in a ref, driven purely by the edit handlers.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  /** Persist the given slicing values and toast the outcome. */
  const save = async (next: SlicingConfig) => {
    // Model selection lives in the chat UI (model selector) and is persisted
    // to config.json — intentionally omitted here so a settings save never
    // overwrites it.
    const res = await saveUserConfig({ slicing: next });
    if (res.ok) toast.success(tRef.current("config.saved"));
    else toast.error(tRef.current("config.saveFailed"));
  };

  /** Debounced save after an edit (800ms idle). */
  const scheduleSave = (next: SlicingConfig) => {
    if (!canWrite) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(next), 800);
  };

  const handleRestoreDefaults = () => {
    setMaxSliceMinutes(defaults.maxSliceMinutes);
    setMaxTurnsPerSlice(defaults.maxTurnsPerSlice);
    setIdleGapMinutes(defaults.idleGapMinutes);
    if (!canWrite) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void save({ ...defaults });
  };

  return (
    <div className="space-y-8">
      {/* Data source — demo info banner */}
      {isDemo && (
        <div className="rounded-lg bg-muted/40 p-4 space-y-1">
          <h3 className="text-sm font-medium">{t("demo.heading")}</h3>
          <p className="text-sm text-muted-foreground">{t("demo.description")}</p>
          <a
            href="https://previously.ldwid.com/docs/deployment"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-primary hover:underline"
          >
            {t("demo.setupLink")}
          </a>
        </div>
      )}

      {/* Config — tunable agent behaviour (memory/user/config.json) */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium">{t("config.heading")}</h3>
          <p className="text-sm text-muted-foreground">{t("config.desc")}</p>
        </div>
        {/* Slicing */}
        <div className="grid grid-cols-2 gap-3">
          <Label className="block space-y-1">
            <span className="text-xs font-normal text-muted-foreground">{t("config.maxSliceMinutes")}</span>
            <Input
              type="number"
              min={5}
              max={120}
              value={maxSliceMinutes}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMaxSliceMinutes(v);
                scheduleSave({ maxSliceMinutes: v, maxTurnsPerSlice, idleGapMinutes });
              }}
              disabled={!canWrite}
              className="w-24"
            />
          </Label>
          <Label className="block space-y-1">
            <span className="text-xs font-normal text-muted-foreground">{t("config.maxTurnsPerSlice")}</span>
            <Input
              type="number"
              min={5}
              max={100}
              value={maxTurnsPerSlice}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMaxTurnsPerSlice(v);
                scheduleSave({ maxSliceMinutes, maxTurnsPerSlice: v, idleGapMinutes });
              }}
              disabled={!canWrite}
              className="w-24"
            />
          </Label>
          <Label className="block space-y-1">
            <span className="text-xs font-normal text-muted-foreground">{t("config.idleGapMinutes")}</span>
            <Input
              type="number"
              min={1}
              max={120}
              value={idleGapMinutes}
              onChange={(e) => {
                const v = Number(e.target.value);
                setIdleGapMinutes(v);
                scheduleSave({ maxSliceMinutes, maxTurnsPerSlice, idleGapMinutes: v });
              }}
              disabled={!canWrite}
              className="w-24"
            />
          </Label>
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestoreDefaults}
            disabled={!canWrite}
            title={!canWrite ? "Unavailable in demo mode" : undefined}
          >
            {t("config.restoreDefaults")}
          </Button>
        </div>
      </section>
    </div>
  );
}
