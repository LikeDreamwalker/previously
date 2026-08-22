"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Check, Info } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { ProviderIcon, stripProviderPrefix } from "./provider-icon";
import { useAvailableModels, type AvailableModel } from "@/hooks/use-available-models";

type EffortLevel = "low" | "medium" | "high";

export interface ModelDefaults {
  thinking: boolean;
  effort: EffortLevel;
}

/** Display names of the subscription CLIs (brand names — locale-neutral). */
const BRIDGE_AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
};

/** The agent CLI a bridge model id drives (`bridge/codex` → "codex"). */
function bridgeAgentOf(id: string): string {
  return id.startsWith("bridge/") ? id.slice("bridge/".length) : "";
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
 * The selection persists to memory/user/config.json (ChatPage owns the model
 * state). v0.9: the "Advanced" worker-pin sheet was removed — every sub-agent
 * now runs on the main model via the unified sub-agent runner, so the worker
 * pin had no production consumer (see src/lib/models/worker.ts).
 */
export function ModelSelector({
  currentModelId,
  thinking,
  onModelChange,
  onThinkingChange,
}: ModelSelectorProps) {
  const t = useTranslations("chat.input");
  const models = useAvailableModels();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
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

  if (models.length <= 1) return null;

  const groups = groupByProvider(models);
  // Thinking/effort are no-ops for the subscription bridge (see
  // effort-injector.ts) — hide the knobs while a bridge model is selected.
  const isBridgeSelected = currentModelId.startsWith("bridge/");

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
                    className="h-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center gap-1 px-2"
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
              {providerModels.map((m) => {
                const isBridge = m.provider === "bridge";
                const unavailable = isBridge && m.available === false;
                return (
                  <div key={m.id} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={unavailable}
                      onClick={() => handleSelect(m)}
                      className={`min-w-0 flex-1 text-left px-2 py-1.5 rounded text-xs flex items-center justify-between gap-2 ${
                        m.id === currentModelId
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted"
                      } disabled:opacity-50 disabled:hover:bg-transparent`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ProviderIcon
                          provider={m.provider}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className="truncate">
                          {m.name}
                          {unavailable && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {t("bridgeNotInstalled")}
                            </span>
                          )}
                        </span>
                      </span>
                      {m.id === currentModelId && (
                        <Check className="h-3 w-3 shrink-0" />
                      )}
                    </button>
                    {isBridge && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              tabIndex={0}
                              className="shrink-0 rounded p-1 text-muted-foreground/70 hover:text-foreground"
                            >
                              <Info className="h-3 w-3" />
                            </span>
                          }
                        />
                        <TooltipContent side="top" className="max-w-56">
                          {t("bridgeHint", {
                            agent:
                              BRIDGE_AGENT_LABELS[bridgeAgentOf(m.id)] ?? m.name,
                          })}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {!isBridgeSelected && (
            <div className="mt-1 flex items-center justify-between gap-2 border-t px-2 pt-2">
              <span className="text-xs text-muted-foreground">
                {t("thinkingLabel")}
              </span>
              <Switch
                size="sm"
                checked={thinking}
                onCheckedChange={onThinkingChange}
              />
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
