"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveUserConfig } from "@/lib/config/actions";
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
  const [maxSliceMinutes, setMaxSliceMinutes] = useState(initialConfig.slicing.maxSliceMinutes);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSavedMsg, setConfigSavedMsg] = useState("");

  const handleConfigSave = async () => {
    setConfigSaving(true);
    setConfigSavedMsg("");
    // Model selection lives in the chat UI (model selector) and is persisted
    // to config.json — intentionally omitted here so the settings save never
    // overwrites it.
    const res = await saveUserConfig({
      slicing: { maxTurnsPerSlice, maxSliceMinutes },
    });
    setConfigSaving(false);
    setConfigSavedMsg(res.ok ? t("config.saved") : t("config.saveFailed"));
    if (res.ok) setTimeout(() => setConfigSavedMsg(""), 2500);
  };

  return (
    <div className="space-y-4">
      {/* Data source — demo info banner */}
      {isDemo && (
        <Card className="bg-muted/20">
          <CardHeader>
            <CardTitle>
              <h3>{t("demo.heading")}</h3>
            </CardTitle>
            <CardDescription>{t("demo.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href="https://previously.ldwid.com/docs/deployment"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-primary hover:underline"
            >
              {t("demo.setupLink")}
            </a>
          </CardContent>
        </Card>
      )}

      {/* Config — tunable agent behaviour (memory/user/config.json) */}
      <Card>
        <CardHeader>
          {/* hN inside CardTitle keeps the heading role (Tailwind preflight
              makes it inherit the card-title styling). */}
          <CardTitle>
            <h3>{t("config.heading")}</h3>
          </CardTitle>
          <CardDescription>{t("config.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Slicing */}
          <div className="grid grid-cols-2 gap-3">
            <Label className="block space-y-1">
              <span className="text-xs font-normal text-muted-foreground">{t("config.maxSliceMinutes")}</span>
              <Input type="number" min={5} max={120} value={maxSliceMinutes} onChange={(e) => setMaxSliceMinutes(Number(e.target.value))} className="w-24" />
            </Label>
            <Label className="block space-y-1">
              <span className="text-xs font-normal text-muted-foreground">{t("config.maxTurnsPerSlice")}</span>
              <Input type="number" min={5} max={100} value={maxTurnsPerSlice} onChange={(e) => setMaxTurnsPerSlice(Number(e.target.value))} className="w-24" />
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={handleConfigSave} disabled={configSaving || !canWrite} title={!canWrite ? "Unavailable in demo mode" : undefined}>
              {configSaving ? t("config.saving") : t("config.save")}
            </Button>
            {configSavedMsg && <span className="text-xs text-muted-foreground">{configSavedMsg}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
