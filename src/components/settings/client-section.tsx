"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BridgeAgentIcon } from "@/components/chat/provider-icon";

/**
 * Client-mode settings block — rendered only when the kernel runs as a local
 * client instance (the settings page gates server-side on isClientMode()).
 * Sub-blocks: read-only runtime status (table), local agent CLI detection
 * (table, /api/client/agents), and the model engine (local agent / BYOK,
 * switched via tabs) — saved via /api/client/config. Cloud deployments
 * configure provider API keys in their deployment environment instead, so
 * there is deliberately no env-var engine option here.
 * Deliberately a status panel, not a console: executionBackend and the
 * per-agent model/effort tuning have no UI here (advanced users edit
 * config.json directly; the API still round-trips both fields).
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

/**
 * The `brain` field as the API reports it. The env-var "api-key" brain is a
 * legacy/hand-edit shape with no UI — the settings page only offers the
 * local agent (bridge) and BYOK engines, so an api-key brain reads as
 * "unset" here and a save clears it.
 */
type Brain =
  | { type: "api-key"; env: string; model?: string }
  | { type: "bridge"; agent: string };

/** The `byok` section of the client config (user's own API key). */
interface ByokConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

interface ClientConfig {
  home: string | null;
  exists: boolean;
  executionBackend: string | null;
  brain: Brain | null;
  agents: Record<string, { model?: string; effort?: string }> | null;
  byok: ByokConfig | null;
}

/** One row of GET /api/client/agents. */
interface AgentInfo {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
}

const BRIDGE_AGENTS = ["claude", "codex", "kimi"] as const;

/** BYOK provider options — mirror BYOK_PROVIDERS in src/lib/models/registry.ts
 *  plus "custom" (own base URL). Client-side copy; the server validates. */
const BYOK_PROVIDERS = [
  "deepseek",
  "openai",
  "moonshotai",
  "alibaba",
  "google",
  "mistral",
  "xai",
  "groq",
  "custom",
] as const;

const blockHeadingClass = "text-base font-medium";
const subHeadingClass = "text-sm font-medium";
const blockDescClass = "text-sm text-muted-foreground";

export function ClientSection() {
  const t = useTranslations("settings.client");

  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  /** Cloud mode (status API 404) or unreachable API — render nothing.
   *  Fallback only: the page already gates server-side on isClientMode(). */
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Local agent detection (null = still probing) ──
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // ── Editable fields (initialized from the loaded config) ──
  const [brainType, setBrainType] = useState<"unset" | "bridge" | "byok">("unset");
  const [brainAgent, setBrainAgent] = useState<string>("claude");
  // ── BYOK fields (user's own API key — the recommended engine) ──
  const [byokProvider, setByokProvider] = useState<string>("deepseek");
  const [byokApiKey, setByokApiKey] = useState("");
  const [byokBaseUrl, setByokBaseUrl] = useState("");
  const [byokModel, setByokModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Cloud mode answers 404 — the section hides itself. Kept as a
        // runtime fallback (e.g. cloud-targeted builds that tree-shake
        // client-only UI, or an unreachable API); the normal path is the
        // server-side isClientMode() gate in the settings page.
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
        if (c.brain?.type === "bridge") {
          setBrainType("bridge");
          setBrainAgent(c.brain.agent);
        }
        // Pre-fill the BYOK form whenever a section exists; it only drives
        // the engine tabs when no engine is configured (a stored engine
        // wins, so re-saving a local-agent choice doesn't bounce to byok).
        if (c.byok) {
          if (!c.brain) setBrainType("byok");
          setByokProvider(c.byok.provider);
          setByokApiKey(c.byok.apiKey);
          setByokBaseUrl(c.byok.baseUrl ?? "");
          setByokModel(c.byok.model);
        }
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
        brainType === "bridge" ? { type: "bridge", agent: brainAgent } : null;
      // Tri-state per field: absent keys are left untouched on the server.
      // The UI only owns `brain` (and `byok` when that engine is selected) —
      // executionBackend and per-agent `agents` tuning are absent from the
      // payload, so hand-edited config.json values survive a save.
      const res = await fetch("/api/client/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brain,
          ...(brainType === "byok"
            ? {
                byok: {
                  provider: byokProvider,
                  apiKey: byokApiKey.trim(),
                  ...(byokProvider === "custom" && byokBaseUrl.trim()
                    ? { baseUrl: byokBaseUrl.trim() }
                    : {}),
                  model: byokModel.trim(),
                },
              }
            : {}),
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

  const labelClass = "text-xs font-normal text-muted-foreground";
  const canSave = !!config?.home;

  // Render nothing until the status probe resolves — in cloud mode the probe
  // 404s and the section never appears at all.
  if (hidden || !status) return null;

  /** Detection row for one bridge agent, or undefined before the probe lands. */
  const detection = (name: string) => agents?.find((a) => a.name === name);
  /** Confirmed NOT installed (false while the probe is still in flight). */
  const notInstalled = (name: string) =>
    agents !== null && detection(name)?.found === false;
  /** The configured local agent isn't installed on this machine. */
  const configuredAgentMissing = notInstalled(brainAgent);

  return (
    <section data-slot="settings-client" className="space-y-8">
      <div className="space-y-1">
        <h3 className={blockHeadingClass}>{t("heading")}</h3>
        <p className={blockDescClass}>{t("desc")}</p>
      </div>

      {loadError && (
        <p className="text-xs text-red-500">{t("loadFailed")}: {loadError}</p>
      )}

      {/* ── 运行状态 / Status (read-only) ── */}
      <div className="space-y-3">
        <h4 className={subHeadingClass}>{t("statusHeading")}</h4>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="w-36 text-muted-foreground">{t("versionLabel")}</TableCell>
              <TableCell className="whitespace-normal">v{status.version} · {status.mode}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="w-36 text-muted-foreground">{t("homeLabel")}</TableCell>
              <TableCell className="whitespace-normal break-all">
                {status.home ?? (
                  <span className="text-muted-foreground/60">{t("homeMissing")}</span>
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="w-36 text-muted-foreground">{t("memoryRootLabel")}</TableCell>
              <TableCell className="whitespace-normal break-all">{status.memoryRoot ?? "—"}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="w-36 text-muted-foreground">{t("bridgeLabel")}</TableCell>
              <TableCell className="whitespace-normal break-all">
                {status.bridge.active
                  ? t("bridgeActive", { agent: status.bridge.agent ?? "" })
                  : t("bridgeInactive")}
                <span className="text-muted-foreground/60">
                  {" "}({status.bridge.cmd}, {Math.round(status.bridge.timeoutMs / 60000)} min)
                </span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="w-36 text-muted-foreground">{t("modelsLabel")}</TableCell>
              <TableCell className="whitespace-normal">
                {status.models.length === 0
                  ? t("modelsEmpty")
                  : status.models.map((m) => m.id).join(", ")}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <Separator />

      {/* ── 本地 Agent / Local agents (read-only detection) ── */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h4 className={subHeadingClass}>{t("agentsHeading")}</h4>
          <p className={blockDescClass}>{t("agentsDesc")}</p>
        </div>
        {agents === null && !agentsError && (
          <p className="text-xs text-muted-foreground/60">{t("agentsLoading")}</p>
        )}
        {agentsError && (
          <p className="text-xs text-muted-foreground/60">
            {t("agentsLoadFailed")}: {agentsError}
          </p>
        )}
        {agents && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colAgent")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colVersion")}</TableHead>
                <TableHead>{t("colPath")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {BRIDGE_AGENTS.map((name) => {
                const a = detection(name);
                return (
                  <TableRow key={name}>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <BridgeAgentIcon agent={name} className="size-3.5" />
                        <span className="font-mono">{name}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {a?.found ? (
                        <span className="text-green-600 dark:text-green-400">
                          {t("agentInstalled")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">
                          {t("agentNotInstalled")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {a?.version ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-normal break-all text-muted-foreground/60">
                      {a?.path ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {config && (
        <>
          <Separator />

          {/* ── 模型引擎 / Model engine ── */}
          <div className="space-y-4">
            <h4 className={subHeadingClass}>{t("brainHeading")}</h4>
            <Tabs
              value={brainType}
              onValueChange={(v) => setBrainType(v as typeof brainType)}
            >
              <TabsList>
                <TabsTrigger value="bridge">{t("engineLocalAgent")}</TabsTrigger>
                <TabsTrigger value="byok">{t("brainByok")}</TabsTrigger>
              </TabsList>

              {/* 本地 Agent / local agent engine (default — no API key) */}
              <TabsContent value="bridge" className="space-y-3 pt-3">
                <p className={blockDescClass}>{t("engineLocalAgentDesc")}</p>
                <div className="space-y-1">
                  <Label className="block space-y-1">
                    <span className={labelClass}>{t("brainAgentLabel")}</span>
                    <Select
                      value={brainAgent}
                      onValueChange={(v) => {
                        if (v) setBrainAgent(v);
                      }}
                    >
                      <SelectTrigger className="w-full max-w-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BRIDGE_AGENTS.map((a) => {
                          // Keep the currently-configured agent selectable even
                          // when undetected — the config may be valid on another
                          // machine (flagged by the warning below).
                          const disabled = notInstalled(a) && a !== brainAgent;
                          return (
                            <SelectItem key={a} value={a} disabled={disabled}>
                              <BridgeAgentIcon agent={a} className="size-3.5" />
                              {a}
                              {notInstalled(a) ? ` (${t("agentNotInstalled")})` : ""}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </Label>
                  {configuredAgentMissing && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {t("bridgeAgentNotDetected", { agent: brainAgent })}
                    </p>
                  )}
                </div>
              </TabsContent>

              {/* 自带 API Key / BYOK (recommended) */}
              <TabsContent value="byok" className="space-y-3 pt-3">
                <p className={blockDescClass}>{t("byokDesc")}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Label className="block space-y-1">
                    <span className={labelClass}>{t("byokProviderLabel")}</span>
                    <Select
                      value={byokProvider}
                      onValueChange={(v) => {
                        if (v) setByokProvider(v);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BYOK_PROVIDERS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p === "custom" ? t("byokProviderCustom") : p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                  <Label className="block space-y-1">
                    <span className={labelClass}>{t("byokApiKeyLabel")}</span>
                    <Input
                      type="password"
                      value={byokApiKey}
                      onChange={(e) => setByokApiKey(e.target.value)}
                      placeholder="sk-…"
                      autoComplete="off"
                    />
                  </Label>
                </div>
                {byokProvider === "custom" && (
                  <Label className="block space-y-1">
                    <span className={labelClass}>{t("byokBaseUrlLabel")}</span>
                    <Input
                      type="text"
                      value={byokBaseUrl}
                      onChange={(e) => setByokBaseUrl(e.target.value)}
                      placeholder="https://…/v1"
                    />
                  </Label>
                )}
                <Label className="block space-y-1">
                  <span className={labelClass}>{t("byokModelLabel")}</span>
                  <Input
                    type="text"
                    value={byokModel}
                    onChange={(e) => setByokModel(e.target.value)}
                    placeholder={t("byokModelPlaceholder")}
                  />
                </Label>
              </TabsContent>
            </Tabs>
            {brainType === "unset" && (
              <p className="text-xs text-muted-foreground/60">{t("engineUnsetHint")}</p>
            )}
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
          <p className="text-xs text-muted-foreground/60">{t("applyHint")}</p>
        </>
      )}
    </section>
  );
}
