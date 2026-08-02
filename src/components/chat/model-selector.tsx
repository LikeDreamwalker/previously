"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Check, Settings2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ProviderIcon, stripProviderPrefix } from "./provider-icon";
import { getUserConfig, saveUserConfig } from "@/lib/config/actions";

type EffortLevel = "low" | "medium" | "high";

export interface ModelDefaults {
  thinking: boolean;
  effort: EffortLevel;
}

interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  defaultThinking: boolean;
  defaultEffort: EffortLevel;
}

interface ModelSelectorProps {
  /** Currently selected model id (from ChatPage state). */
  currentModelId: string;
  /** Thinking on/off — owned by ChatPage, toggled here. */
  thinking: boolean;
  onModelChange: (modelId: string, defaults: ModelDefaults) => void;
  onThinkingChange: (thinking: boolean) => void;
}

/** Group a model list by provider, preserving order. */
function groupByProvider(models: AvailableModel[]): Map<string, AvailableModel[]> {
  const groups = new Map<string, AvailableModel[]>();
  for (const m of models) {
    const list = groups.get(m.provider) ?? [];
    list.push(m);
    groups.set(m.provider, list);
  }
  return groups;
}

/**
 * Model selector for the chat toolbar. Fetches the server-side model catalog
 * (/api/models — env-gated) and shows a grouped picker plus a thinking toggle.
 * Hides entirely when there are 0 or 1 models to choose from.
 *
 * An "Advanced" entry opens a sheet for the WORKER model config — the cheap
 * internal tier (recall, tagging, slice marking). Both the main selection and
 * the worker config persist to memory/user/config.json (ChatPage owns the main
 * model state; this component owns the worker sheet state).
 */
export function ModelSelector({
  currentModelId,
  thinking,
  onModelChange,
  onThinkingChange,
}: ModelSelectorProps) {
  const t = useTranslations("chat.input");
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [mounted, setMounted] = useState(false);

  // ── Advanced worker config state ────────────────────────────────────────
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [workerMode, setWorkerMode] = useState<"auto" | "manual">("auto");
  const [workerModel, setWorkerModel] = useState("");

  useEffect(() => {
    setMounted(true);
    fetch("/api/models")
      .then((r) => r.json())
      .then((data) => setModels(data.models ?? []))
      .catch(() => setModels([]));

    // Worker config comes from config.json.
    getUserConfig()
      .then((cfg) => {
        setWorkerMode(cfg.worker?.mode ?? "auto");
        setWorkerModel(cfg.worker?.provider ?? "");
      })
      .catch(() => {});
  }, []);

  const current = models.find((m) => m.id === currentModelId);
  // Trigger shows the compact name (brand prefix stripped — the logo already
  // conveys the provider); the popover list keeps the full name.
  const shortName = current
    ? stripProviderPrefix(current.name, current.provider)
    : mounted
      ? currentModelId
      : "…";

  const handleSelect = useCallback(
    (m: AvailableModel) => {
      onModelChange(m.id, {
        thinking: m.defaultThinking,
        effort: m.defaultEffort,
      });
    },
    [onModelChange],
  );

  const saveWorker = () => {
    void saveUserConfig({
      worker: {
        mode: workerMode,
        provider: workerMode === "manual" ? workerModel : "",
      },
    });
    setAdvancedOpen(false);
  };

  if (models.length <= 1) return null;

  const groups = groupByProvider(models);

  return (
    <>
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="h-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 transition-colors flex items-center justify-center gap-1 px-2"
                  >
                    <ProviderIcon
                      provider={current?.provider ?? ""}
                      className="h-3 w-3 shrink-0"
                    />
                    <span className="text-[10px] font-medium leading-none max-w-[72px] truncate">
                      {shortName}
                    </span>
                  </button>
                }
              />
            }
          />
          <TooltipContent side="top">{t("modelTooltip")}</TooltipContent>
        </Tooltip>

        <PopoverContent align="start" sideOffset={8} className="w-52 p-1.5">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {t("modelLabel")}
          </div>

          {[...groups.entries()].map(([provider, providerModels]) => (
            <div key={provider} className="mb-1">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                {providerModels[0]?.providerName ?? t(`modelGroup.${provider}`)}
              </div>
              {providerModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleSelect(m)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between gap-2 ${
                    m.id === currentModelId
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProviderIcon
                      provider={m.provider}
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="truncate">{m.name}</span>
                  </span>
                  {m.id === currentModelId && <Check className="h-3 w-3 shrink-0" />}
                </button>
              ))}
            </div>
          ))}

          <div className="mt-1 flex items-center justify-between gap-2 border-t px-2 pt-2">
            <span className="text-xs text-muted-foreground">
              {t("thinkingLabel")}
            </span>
            <div className="flex items-center gap-0.5">
              <Switch
                size="sm"
                checked={thinking}
                onCheckedChange={onThinkingChange}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("advanced")}
                      onClick={() => setAdvancedOpen(true)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 transition-colors"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </button>
                  }
                />
                <TooltipContent side="top">{t("advanced")}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* ── Advanced: worker model config ─────────────────────────────── */}
      <Sheet open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>{t("workerLabel")}</SheetTitle>
            <SheetDescription>{t("workerSameAsAgentDesc")}</SheetDescription>
          </SheetHeader>

          <div className="flex items-center justify-between gap-2 px-4">
            <span className="text-xs text-muted-foreground">
              {t("workerSameAsAgent")}
            </span>
            <Switch
              size="sm"
              checked={workerMode === "auto"}
              onCheckedChange={(on) =>
                setWorkerMode(on ? "auto" : "manual")
              }
            />
          </div>

          {workerMode === "manual" && (
            <div className="flex-1 overflow-y-auto px-2">
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {t("workerModelLabel")}
              </div>
              {[...groups.entries()].map(([provider, providerModels]) => (
                <div key={provider} className="mb-1">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {providerModels[0]?.providerName ?? t(`modelGroup.${provider}`)}
                  </div>
                  {providerModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setWorkerModel(m.id)}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between gap-2 ${
                        m.id === workerModel
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ProviderIcon
                          provider={m.provider}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className="truncate">{m.name}</span>
                      </span>
                      {m.id === workerModel && <Check className="h-3 w-3 shrink-0" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          <SheetFooter>
            <Button size="sm" onClick={saveWorker}>
              {t("workerSave")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
