"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * Client-mode settings section — rendered only when the kernel runs as a
 * local client instance (the page gates on isClientMode()). Four sub-blocks
 * in one section card: read-only runtime status, local agent CLI detection
 * (/api/client/agents), brain selection, and the execution backend — the
 * latter two saved via /api/client/config. Deliberately a status panel,
 * not a console.
 */

interface ClientStatus {
  mode: string;
  version: string;
  memoryRoot: string | null;
  home: string | null;
  bridge: {
    cmd: string;
    agent: string | null;
    active: boolean;
    timeoutMs: number;
  };
  models: Array<{ id: string; name: string; provider: string; providerName: string }>;
}

type Brain =
  | { type: "api-key"; env: string; model?: string }
  | { type: "bridge"; agent: string };

interface ClientConfig {
  home: string | null;
  exists: boolean;
  executionBackend: string | null;
  brain: Brain | null;
  agents: Record<string, { model?: string; effort?: string }> | null;
}

/** One row of GET /api/client/agents. */
interface AgentInfo {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
}

const BRIDGE_AGENTS = ["claude", "codex", "kimi"] as const;

const subHeadingClass = "text-sm font-medium mb-1";
const subDescClass = "text-xs text-muted-foreground mb-3";

export function ClientSection() {
  const t = useTranslations("settings.client");

  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  /** Cloud mode (status API 404) or unreachable API — render nothing. */
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Local agent detection (null = still probing) ──
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // ── Editable fields (initialized from the loaded config) ──
  const [executionBackend, setExecutionBackend] = useState("");
  const [brainType, setBrainType] = useState<"unset" | "api-key" | "bridge">("unset");
  const [brainEnv, setBrainEnv] = useState("");
  const [brainModel, setBrainModel] = useState("");
  const [brainAgent, setBrainAgent] = useState<string>("claude");
  // ── Per-agent bridge params (empty string = unset → CLI default) ──
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [agentEfforts, setAgentEfforts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Cloud mode answers 404 — the section hides itself. This is the
        // runtime mode check (the page is prerendered before mode is known).
        const statusRes = await fetch("/api/client/status");
        if (!statusRes.ok) {
          if (!cancelled) setHidden(true);
          return;
        }
        const s = (await statusRes.json()) as ClientStatus;
        if (cancelled) return;
        setStatus(s);

        // Detection is decorative — its failure must not sink the section.
        fetch("/api/client/agents")
          .then(async (res) => {
            if (!res.ok) throw new Error(`agents ${res.status}`);
            const body = (await res.json()) as { agents: AgentInfo[] };
            if (!cancelled) setAgents(body.agents);
          })
          .catch((e) => {
            if (!cancelled) {
              setAgentsError(e instanceof Error ? e.message : String(e));
            }
          });

        const configRes = await fetch("/api/client/config");
        if (!configRes.ok) {
          throw new Error(`config ${configRes.status}`);
        }
        const c = (await configRes.json()) as ClientConfig;
        if (cancelled) return;
        setConfig(c);
        setExecutionBackend(c.executionBackend ?? "");
        if (c.brain?.type === "api-key") {
          setBrainType("api-key");
          setBrainEnv(c.brain.env);
          setBrainModel(c.brain.model ?? "");
        } else if (c.brain?.type === "bridge") {
          setBrainType("bridge");
          setBrainAgent(c.brain.agent);
        }
        const models: Record<string, string> = {};
        const efforts: Record<string, string> = {};
        for (const a of BRIDGE_AGENTS) {
          const entry = c.agents?.[a];
          if (entry?.model) models[a] = entry.model;
          if (entry?.effort) efforts[a] = entry.effort;
        }
        setAgentModels(models);
        setAgentEfforts(efforts);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSavedMsg("");
    try {
      const brain: Brain | null =
        brainType === "api-key"
          ? {
              type: "api-key",
              env: brainEnv.trim(),
              ...(brainModel.trim() ? { model: brainModel.trim() } : {}),
            }
          : brainType === "bridge"
            ? { type: "bridge", agent: brainAgent }
            : null;
      // The UI owns the `agents` field like it owns `brain`: the posted
      // object is the full desired state (null clears it). Values for
      // agents not detected on this machine are kept from the loaded config
      // (state is initialized for all agents; rows render only for installed).
      const agents: Record<string, { model?: string; effort?: string }> = {};
      for (const a of BRIDGE_AGENTS) {
        const model = agentModels[a]?.trim();
        const effort = agentEfforts[a];
        const entry: { model?: string; effort?: string } = {};
        if (model) entry.model = model;
        if (a !== "kimi" && effort) entry.effort = effort;
        if (entry.model || entry.effort) agents[a] = entry;
      }
      const res = await fetch("/api/client/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionBackend: executionBackend.trim() || null,
          brain,
          agents: Object.keys(agents).length > 0 ? agents : null,
        }),
      });
      const body = (await res.json()) as ClientConfig & { error?: string };
      if (!res.ok) {
        setSavedMsg(body.error ?? t("saveFailed"));
      } else {
        setConfig(body);
        setSavedMsg(t("saved"));
        setTimeout(() => setSavedMsg(""), 2500);
      }
    } catch {
      setSavedMsg(t("saveFailed"));
    }
    setSaving(false);
  };

  const inputClass =
    "w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
  const labelClass = "text-xs text-muted-foreground";
  const canSave = !!config?.home;

  // Render nothing until the status probe resolves — in cloud mode the probe
  // 404s and the section never appears at all.
  if (hidden || !status) return null;

  /** Detection row for one bridge agent, or undefined before the probe lands. */
  const detection = (name: string) => agents?.find((a) => a.name === name);
  /** The saved bridge agent isn't installed on this machine. */
  const configuredAgentMissing =
    agents !== null && detection(brainAgent)?.found === false;
  /** Agents detected as installed — the only ones that get a params row. */
  const installedAgents = BRIDGE_AGENTS.filter((a) => detection(a)?.found === true);

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium mb-1">{t("heading")}</h3>
      <p className="text-xs text-muted-foreground mb-4">{t("desc")}</p>

      {loadError && (
        <p className="text-xs text-red-500">{t("loadFailed")}: {loadError}</p>
      )}

      {/* ── 运行状态 / Status (read-only) ── */}
      <div className="mb-4">
        <h4 className={subHeadingClass}>{t("statusHeading")}</h4>
        <dl className="space-y-2 text-xs">
          <div className="flex gap-2">
            <dt className={labelClass}>{t("versionLabel")}:</dt>
            <dd>v{status.version} · {status.mode}</dd>
          </div>
          <div className="flex gap-2">
            <dt className={labelClass}>{t("homeLabel")}:</dt>
            <dd className="break-all">
              {status.home ?? (
                <span className="text-muted-foreground/60">{t("homeMissing")}</span>
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className={labelClass}>{t("memoryRootLabel")}:</dt>
            <dd className="break-all">{status.memoryRoot ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className={labelClass}>{t("bridgeLabel")}:</dt>
            <dd className="break-all">
              {status.bridge.active
                ? t("bridgeActive", { agent: status.bridge.agent ?? "" })
                : t("bridgeInactive")}
              <span className="text-muted-foreground/60">
                {" "}({status.bridge.cmd}, {Math.round(status.bridge.timeoutMs / 60000)} min)
              </span>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className={labelClass}>{t("modelsLabel")}:</dt>
            <dd>
              {status.models.length === 0
                ? t("modelsEmpty")
                : status.models.map((m) => m.id).join(", ")}
            </dd>
          </div>
        </dl>
      </div>

      {/* ── 本地 Agent / Local agents (read-only detection) ── */}
      <div className="pt-4 border-t border-border mb-4">
        <h4 className={subHeadingClass}>{t("agentsHeading")}</h4>
        <p className={subDescClass}>{t("agentsDesc")}</p>
        {agents === null && !agentsError && (
          <p className="text-xs text-muted-foreground/60">{t("agentsLoading")}</p>
        )}
        {agentsError && (
          <p className="text-xs text-muted-foreground/60">
            {t("agentsLoadFailed")}: {agentsError}
          </p>
        )}
        {agents && (
          <ul className="space-y-1 text-xs">
            {agents.map((a) => (
              <li key={a.name} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono">{a.name}</span>
                {a.found ? (
                  <span className="text-green-600 dark:text-green-400">
                    {t("agentInstalled")}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60">
                    {t("agentNotInstalled")}
                  </span>
                )}
                {a.version && (
                  <span className="text-muted-foreground">{a.version}</span>
                )}
                {a.path && (
                  <span className="text-muted-foreground/60 break-all">{a.path}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {config && (
        <div className="space-y-4 pt-4 border-t border-border">
          {/* ── 大脑来源 / Brain ── */}
          <div className="space-y-2">
            <h4 className={subHeadingClass}>{t("brainHeading")}</h4>
            <select
              value={brainType}
              onChange={(e) => setBrainType(e.target.value as typeof brainType)}
              className={inputClass}
            >
              <option value="unset">{t("brainUnset")}</option>
              <option value="api-key">{t("brainApiKey")}</option>
              <option value="bridge">{t("brainBridge")}</option>
            </select>

            {brainType === "api-key" && (
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className={labelClass}>{t("brainEnvLabel")}</span>
                  <input
                    type="text"
                    value={brainEnv}
                    onChange={(e) => setBrainEnv(e.target.value)}
                    placeholder="DEEPSEEK_API_KEY"
                    className={inputClass}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={labelClass}>{t("brainModelLabel")}</span>
                  <input
                    type="text"
                    value={brainModel}
                    onChange={(e) => setBrainModel(e.target.value)}
                    placeholder={t("brainModelPlaceholder")}
                    className={inputClass}
                  />
                </label>
              </div>
            )}

            {brainType === "bridge" && (
              <div className="space-y-1">
                <label className="block space-y-1">
                  <span className={labelClass}>{t("brainAgentLabel")}</span>
                  <select
                    value={brainAgent}
                    onChange={(e) => setBrainAgent(e.target.value)}
                    className={inputClass}
                  >
                    {BRIDGE_AGENTS.map((a) => {
                      const installed = detection(a)?.found;
                      // Keep the currently-configured agent selectable even
                      // when undetected — the config may be valid on another
                      // machine (flagged by the warning below).
                      const disabled =
                        agents !== null && installed === false && a !== brainAgent;
                      return (
                        <option key={a} value={a} disabled={disabled}>
                          {a}
                          {agents !== null && installed === false
                            ? ` (${t("agentNotInstalled")})`
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {configuredAgentMissing && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t("bridgeAgentNotDetected", { agent: brainAgent })}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Agent 参数 / Agent parameters (installed agents only) ── */}
          {installedAgents.length > 0 && (
            <div className="space-y-2">
              <h4 className={subHeadingClass}>{t("agentParamsHeading")}</h4>
              <p className={subDescClass}>{t("agentParamsDesc")}</p>
              <div className="space-y-3">
                {installedAgents.map((a) => (
                  <div key={a} className="space-y-1">
                    <span className="text-xs font-medium font-mono">{a}</span>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block space-y-1">
                        <span className={labelClass}>{t("agentModelLabel")}</span>
                        <input
                          type="text"
                          value={agentModels[a] ?? ""}
                          onChange={(e) =>
                            setAgentModels((prev) => ({ ...prev, [a]: e.target.value }))
                          }
                          placeholder={t("agentModelPlaceholder")}
                          className={inputClass}
                        />
                      </label>
                      {a !== "kimi" ? (
                        <label className="block space-y-1">
                          <span className={labelClass}>{t("agentEffortLabel")}</span>
                          <select
                            value={agentEfforts[a] ?? ""}
                            onChange={(e) =>
                              setAgentEfforts((prev) => ({ ...prev, [a]: e.target.value }))
                            }
                            className={inputClass}
                          >
                            <option value="">{t("agentEffortDefault")}</option>
                            <option value="low">{t("agentEffortLow")}</option>
                            <option value="medium">{t("agentEffortMedium")}</option>
                            <option value="high">{t("agentEffortHigh")}</option>
                          </select>
                        </label>
                      ) : (
                        <p className="self-end pb-2 text-xs text-muted-foreground/60">
                          {t("agentEffortUnsupported")}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 执行后端 / Execution backend ── */}
          <div className="space-y-1">
            <h4 className={subHeadingClass}>{t("backendHeading")}</h4>
            <input
              type="text"
              value={executionBackend}
              onChange={(e) => setExecutionBackend(e.target.value)}
              placeholder={t("executionBackendPlaceholder")}
              className={inputClass}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={saving || !canSave}
              title={!config.home ? t("homeMissing") : undefined}
            >
              {saving ? t("saving") : t("save")}
            </Button>
            {savedMsg && <span className="text-xs text-muted-foreground">{savedMsg}</span>}
          </div>
          <p className="text-xs text-muted-foreground/60">{t("restartHint")}</p>
        </div>
      )}
    </section>
  );
}
