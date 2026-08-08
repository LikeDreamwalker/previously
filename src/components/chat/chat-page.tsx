"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import type { UIMessage } from "ai";
import { ChatInput } from "./chat-input";
import type { ModelDefaults } from "./model-selector";
import { ChatSection } from "./chat-section";
import { LoopWatcher } from "./loop-watcher";
import { buildMockSteps } from "@/lib/chat/mock-stream";
import type { EvolutionState } from "./evolution-indicator";
import { HorizontalTimeline } from "./horizontal-timeline";
import { HistoricalChatView } from "./historical-chat-view";
import {
  getEpisodicState,
  getMoreSlices,
  getSliceContent,
  type SliceSummary,
  type SliceContent,
} from "@/lib/episodic/actions";
import { getCached, setCache } from "@/lib/chat/slice-cache";
import { NumberTicker } from "@/components/ui/number-ticker";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { getUserConfig, saveUserConfig } from "@/lib/config/actions";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface ChatPageProps {
  children: React.ReactNode;
}

export function ChatPage({ children }: ChatPageProps) {
  return <Inner>{children}</Inner>;
}

// ─── Reconnect persistence ────────────────────────────────────────────────
// The durable workflow run's id is persisted so a reloaded or backgrounded tab
// (phone lock / app switch) can re-attach to the SAME run's stream and replay
// whatever it missed. Cleared when a turn completes cleanly. Guarded so a
// private-mode / SSR environment (no localStorage) degrades to no-op.
const RUN_ID_KEY = "previously:activeRunId";

function readStoredRunId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(RUN_ID_KEY);
  } catch {
    return null;
  }
}

function writeStoredRunId(runId: string): void {
  try {
    localStorage.setItem(RUN_ID_KEY, runId);
  } catch {
    /* private mode — reconnection is best-effort */
  }
}

function clearStoredRunId(): void {
  try {
    localStorage.removeItem(RUN_ID_KEY);
  } catch {
    /* private mode — reconnection is best-effort */
  }
}

// ─── Gap calculator ──────────────────────────────────────────────────

type GapInfo =
  | { count: number; unitKey: string }
  | { special: string }
  | null;

function getGapInfo(fromISO: string, now: number): GapInfo {
  const from = new Date(fromISO).getTime();
  if (Number.isNaN(from) || now < from) return null;
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 5) return { special: "moments" };
  if (minutes < 60) return { count: minutes, unitKey: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { count: hours, unitKey: "hour" };
  const days = Math.floor(hours / 24);
  if (days < 7) return { count: days, unitKey: "day" };
  if (days < 35) return { count: Math.floor(days / 7), unitKey: "week" };
  return { count: Math.floor(days / 30), unitKey: "month" };
}

// ─── Inner ───────────────────────────────────────────────────────────────

function NowPlaceholder({ gapAnchor }: { gapAnchor: string | null }) {
  const t = useTranslations("timeline");
  const [gapInfo, setGapInfo] = useState<GapInfo>(null);

  useEffect(() => {
    setGapInfo(gapAnchor ? getGapInfo(gapAnchor, Date.now()) : null);
  }, [gapAnchor]);

  return (
    <div className="flex flex-col items-center pt-24 pb-20 text-center">
      {gapInfo && (
        "special" in gapInfo ? (
          <p className="mb-5 font-mono text-xs tracking-[0.25em] text-muted-foreground/60">
            {t(`gap.${gapInfo.special}`)}
          </p>
        ) : (
          <p className="mb-5 font-mono text-xs tracking-[0.25em] text-muted-foreground/60">
            <NumberTicker
              value={gapInfo.count}
              className="text-muted-foreground/60"
            />
            {" "}
            {t(`gap.unit.${gapInfo.unitKey}`, { count: gapInfo.count })}
          </p>
        )
      )}
      <TextGenerateEffect
        words={t("panel.now")}
        className="text-5xl sm:text-6xl font-light tracking-tighter leading-none text-foreground"
        filter={false}
        duration={0.3}
        delay={0.2}
        animateOnView
      />
    </div>
  );
}

function Inner({ children }: { children: React.ReactNode }) {
  // ── Model / thinking / effort — reactive, persisted to config.json ─────
  // The single source of truth is memory/user/config.json (cross-device, no
  // localStorage). Defaults here are just the pre-load placeholder; the mount
  // effect reconciles from the saved config.
  const [selectedModel, setSelectedModel] = useState("deepseek-v4-flash");
  const [thinking, setThinking] = useState(true);
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");

  useEffect(() => {
    getUserConfig()
      .then((cfg) => {
        setSelectedModel(cfg.model.provider);
        setThinking(cfg.model.thinking);
        setEffort(cfg.model.reasoningEffort);
      })
      .catch(() => {});
  }, []);

  // Switching models applies that model's defaults (thinking + effort) so the
  // agent is configured sensibly for the newly selected model.
  const handleModelChange = useCallback(
    (modelId: string, defaults: ModelDefaults) => {
      setSelectedModel(modelId);
      setThinking(defaults.thinking);
      setEffort(defaults.effort);
      void saveUserConfig({
        model: {
          provider: modelId,
          thinking: defaults.thinking,
          reasoningEffort: defaults.effort,
        },
      });
    },
    [],
  );

  const handleEffortChange = useCallback((next: "low" | "medium" | "high") => {
    setEffort(next);
    void saveUserConfig({ model: { reasoningEffort: next } });
  }, []);

  const handleThinkingChange = useCallback((next: boolean) => {
    setThinking(next);
    void saveUserConfig({ model: { thinking: next } });
  }, []);

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);
  const [evolutionState, setEvolutionState] = useState<EvolutionState | null>(null);

  // ── Timeline state ──────────────────────────────────────────────────────
  const [timelineSlices, setTimelineSlices] = useState<SliceSummary[]>([]);
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [timelineReady, setTimelineReady] = useState(false);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>("now");
  const [historicalContent, setHistoricalContent] = useState<SliceContent | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);

  // Persona picked from URL — server actions need it because they can't
  // access searchParams on the server side. Defaults to "personal_14".
  const persona = useMemo(() => {
    if (typeof window === "undefined") return "personal_14";
    return new URLSearchParams(window.location.search).get("persona") || "personal_14";
  }, []);

  // Load initial timeline data on mount
  useEffect(() => {
    let cancelled = false;
    getEpisodicState(persona)
      .then((data) => {
        if (cancelled) return;
        setTimelineSlices(data.recent);
        setTimelineHasMore(data.hasMore);
        setTimelineReady(true);
      })
      .catch(() => {
        if (!cancelled) setTimelineReady(true);
      });
    return () => { cancelled = true; };
  }, [persona]);

  // Load more slices
  const handleLoadMore = useCallback(async () => {
    if (timelineLoadingMore || !timelineHasMore) return;
    const oldest = timelineSlices[timelineSlices.length - 1];
    if (!oldest) return;

    setTimelineLoadingMore(true);
    try {
      const data = await getMoreSlices(oldest.start, 10, persona);
      setTimelineSlices((prev) => [...prev, ...data.slices]);
      setTimelineHasMore(data.hasMore);
    } catch {
      // silently fail
    } finally {
      setTimelineLoadingMore(false);
    }
  }, [timelineLoadingMore, timelineHasMore, timelineSlices, persona]);

  // Handle slice selection — keeps old content visible during fetch
  const handleSelectSlice = useCallback(
    async (sliceId: string) => {
      setSelectedSliceId(sliceId);

      if (sliceId === "now") {
        setHistoricalContent(null);
        setHistoricalLoading(false);
        return;
      }

      const cached = getCached(sliceId);
      if (cached) {
        setHistoricalContent(cached.content);
        setHistoricalLoading(false);
        return;
      }

      // Don't clear previous content — keep it visible while loading
      setHistoricalLoading(true);
      try {
        const content = await getSliceContent(sliceId, persona);
        setHistoricalContent(content);
        if (content) {
          setCache(sliceId, content, null);
        }
      } catch {
        // Keep previous content on error, don't wipe it
      } finally {
        setHistoricalLoading(false);
      }
    },
    [persona],
  );

  // ── Mock demo state ─────────────────────────────────────────────────
  const [demoMessages, setDemoMessages] = useState<UIMessage[]>([]);
  const [demoStreaming, setDemoStreaming] = useState(false);
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runDemo = useCallback(() => {
    if (demoTimerRef.current) return;

    setDemoMessages([]);
    setDemoStreaming(true);
    setLastUserMessageAt(new Date().toISOString());

    const steps = buildMockSteps();
    let current: UIMessage = {
      id: `demo-msg-${Date.now()}`,
      role: "assistant",
      parts: [],
      createdAt: new Date(),
    } as UIMessage;

    let cursor = 0;
    const advance = () => {
      if (cursor >= steps.length) {
        setDemoStreaming(false);
        demoTimerRef.current = null;
        return;
      }
      const step = steps[cursor];
      demoTimerRef.current = setTimeout(() => {
        current = step.apply(current);
        setDemoMessages([current]);
        cursor++;
        advance();
      }, step.delay);
    };
    advance();
  }, []);

  const stopDemo = useCallback(() => {
    if (demoTimerRef.current) {
      clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
    setDemoStreaming(false);
  }, []);

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    resumeStream,
  } = useChat({
    // `resume: false` — reconnection is MANUAL (see the reconnect effects
    // below). Auto-resume on mount would 404 against a fresh page with no
    // stored runId and surface a spurious error banner.
    resume: false,
    transport: new WorkflowChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: (config) => ({
        api: config.api,
        headers: config.headers,
        credentials: config.credentials,
        body: {
          messages: config.messages,
          model: selectedModel,
          thinking,
          effort,
          timezone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : "UTC",
          loadedSliceIds: timelineSlices.map((s) => s.slice_id),
        },
      }),
      // Persist the durable run id + chat id the moment a turn starts, so a
      // dropped/reloaded tab can re-attach to the same run's stream.
      onChatSendMessage: (response, options) => {
        const runId = response.headers.get("x-workflow-run-id");
        if (runId) {
          writeStoredRunId(runId);
          try {
            localStorage.setItem("previously:chatId", options.chatId);
          } catch {
            /* best-effort */
          }
        }
      },
      // A clean end means the run is finished — no reconnect needed.
      onChatEnd: () => clearStoredRunId(),
      // Point any reconnect at the durable run (not the random per-mount
      // chatId) so a post-reload resume targets the real stream.
      prepareReconnectToStreamRequest: (config) => {
        const runId = readStoredRunId();
        if (runId) {
          return {
            ...config,
            api: `/api/chat/${encodeURIComponent(runId)}/stream`,
          };
        }
        return config;
      },
    }),
  });

  // ── Reconnect on return to the foreground ────────────────────────────────
  // When the phone locks / the tab is backgrounded mid-turn, the fetch dies
  // (status → "error") even though the durable workflow keeps running. On
  // return, re-attach to the run's stream to replay what was missed. Skip when
  // the turn is still actively streaming or already finished.
  const attemptReconnect = useCallback(() => {
    if (!readStoredRunId()) return;
    // Only reconnect when the previous stream actually DIED (status "error") —
    // not while it's still streaming, finished, or a fresh POST is in flight.
    if (status !== "error") return;
    void resumeStream().catch((err) => {
      // A 404 / "Run not available" means the run already ended/expired — the
      // stored runId is stale, so clear it (otherwise every refresh keeps
      // reconnecting to this dead run). A network error ("Failed to fetch")
      // leaves it — the run may still be alive and retryable. Anything else is
      // surfaced via the existing error banner.
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|Run not available/.test(msg)) {
        clearStoredRunId();
      } else if (!/Failed to fetch/.test(msg)) {
        console.warn("[chat] reconnect failed:", msg);
      }
    });
  }, [status, resumeStream]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") attemptReconnect();
    };
    const onFocus = () => attemptReconnect();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [attemptReconnect]);

  // ── Recover an interrupted turn on page reload ───────────────────────────
  // A reloaded tab has empty React state but a persisted runId if the previous
  // turn was cut off mid-stream — replay it so the user sees the partial result
  // (and its terminal status) instead of a blank chat. No-op on fresh loads.
  useEffect(() => {
    if (!readStoredRunId()) return;
    void resumeStream().catch((err) => {
      // Same stale-runId handling as attemptReconnect: a dead run's id is
      // cleared so a fresh refresh doesn't retry it; a transient network error
      // keeps it (the run may still be active).
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|Run not available/.test(msg)) {
        clearStoredRunId();
      } else if (!/Failed to fetch/.test(msg)) {
        console.warn("[chat] reload reconnect failed:", msg);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isStreaming = status === "streaming" || demoStreaming;
  const isLoading = status === "submitted" || isStreaming;

  const allMessages = useMemo(() => {
    if (demoMessages.length > 0) return demoMessages;
    return messages;
  }, [messages, demoMessages]);

  // ── Background-completion toast ──────────────────────────────────────────
  // A turn that finishes while the tab is backgrounded is exactly the
  // "I come after you're done" moment — nudge the user back. The turn lifecycle
  // itself renders inline in the bubble (chat-message's buildStream), so this
  // only fires the notification.
  const t = useTranslations("chat");
  const backgroundToastShownRef = useRef(false);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      backgroundToastShownRef.current = false;
    }
  }, [status]);

  useEffect(() => {
    const last = allMessages[allMessages.length - 1];
    if (!last || last.role !== "assistant") return;
    const parts = (last.parts ?? []) as Array<{
      type?: string;
      data?: { status?: string };
    }>;
    for (const part of parts) {
      if (part.type !== "data-turn-status") continue;
      if (part.data?.status !== "done") continue;
      if (
        !backgroundToastShownRef.current &&
        typeof document !== "undefined" &&
        document.hidden
      ) {
        backgroundToastShownRef.current = true;
        toast.success(t("turnStatus.backgroundDone"));
      }
    }
  }, [allMessages, t]);

  // Pre-compute the last assistant message ID so isEvolutionTarget doesn't
  // copy and reverse the entire messages array on every render per message.
  const lastAssistantId = useMemo(() => {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === "assistant") return allMessages[i].id;
    }
    return null;
  }, [allMessages]);

  const isEvolutionTarget = useCallback(
    (id: string) => lastAssistantId === id,
    [lastAssistantId],
  );

  const handleSubmit = (message: string) => {
    if (selectedSliceId !== "now") {
      setSelectedSliceId("now");
      setHistoricalContent(null);
    }
    setLastUserMessageAt(new Date().toISOString());
    sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
    // v0.7b: self-evolution runs INLINE inside housekeeping (the turn's stream
    // carries data-evolution chunks) — no separate evolution request here.
  };

  // v0.7b: watch the turn stream for data-evolution chunks and drive the
  // EvolutionIndicator from them — the synchronous inline run streams reading →
  // reviewing → result while the turn is processing, so the user sees progress.
  const lastEvolutionDataRef = useRef<string>("");
  useEffect(() => {
    if (demoStreaming) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    let found: EvolutionState | undefined;
    for (const p of last.parts) {
      if (p.type === "data-evolution") {
        found = (p as { data?: EvolutionState }).data ?? found;
      }
    }
    if (!found) return;
    const key = JSON.stringify(found);
    if (key !== lastEvolutionDataRef.current) {
      lastEvolutionDataRef.current = key;
      setEvolutionState(found);
    }
  }, [messages, demoStreaming]);

  const showingLive = selectedSliceId === "now";

  return (
    <>
      {/* ── Screen 1: Hero — full viewport ─────────────────────────────── */}
      <section className="h-screen">
        {children}
      </section>

      {/* ── Screen 2: Timeline + Content ───────────────────────────────── */}
      <div>
        {/* ── Sticky timeline — snaps below AppHeader (fixed h-12) ────────── */}
        <div className="sticky top-12 z-10 bg-background/90 backdrop-blur-md">
          <HorizontalTimeline
            slices={timelineSlices}
            selectedId={selectedSliceId}
            onSelect={handleSelectSlice}
            onLoadMore={handleLoadMore}
            hasMore={timelineHasMore}
            loadingMore={timelineLoadingMore}
          />
        </div>

        {/* ── Chat content — natural document flow ────────────────────────── */}
        <div className="min-h-[calc(100vh-12rem)] pb-24">
        {showingLive ? (
          allMessages.length === 0 && !isLoading ? (
            <div className="flex items-center justify-center min-h-[calc(100vh-13rem)]">
              <NowPlaceholder
                gapAnchor={timelineSlices[0]?.start ?? null}
              />
            </div>
          ) : (
            <div className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8 min-h-[calc(100vh-13rem)]">
              <ChatSection
                messages={allMessages}
                isStreaming={isStreaming}
                isLoading={isLoading}
                error={error}
                lastUserMessageAt={lastUserMessageAt}
                evolutionState={evolutionState}
                isEvolutionTarget={isEvolutionTarget}
              />
              <LoopWatcher messages={messages} />
            </div>
          )
        ) : (
          <HistoricalChatView
            content={historicalContent}
            loading={historicalLoading}
          />
        )}
      </div>
      </div>

      {/* ── Fixed bottom bar ────────────────────────────────────────────── */}
      <div className="fixed bottom-0 inset-x-0 z-10">
        <div className="pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
          <div className="mx-auto w-full md:max-w-2xl px-4 sm:px-6 lg:px-8">
            <ChatInput
              onSubmit={handleSubmit}
              isLoading={isLoading}
              onStop={demoStreaming ? stopDemo : stop}
              onDemo={runDemo}
              demoRunning={demoStreaming}
              currentModelId={selectedModel}
              currentEffort={effort}
              thinking={thinking}
              onModelChange={handleModelChange}
              onEffortChange={handleEffortChange}
              onThinkingChange={handleThinkingChange}
            />
          </div>
        </div>
      </div>
    </>
  );
}
