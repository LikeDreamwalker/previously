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
import { TimelineWheel } from "./timeline-wheel";
import { HistoricalChatView } from "./historical-chat-view";
import { RelativeTimeReadout } from "./relative-time";
import { EmptyBriefing } from "./empty-briefing";
import { AnimatePresence, motion } from "motion/react";
import {
  getEpisodicState,
  getSliceContent,
  type SliceSummary,
  type SliceContent,
} from "@/lib/episodic/actions";
import { getCached, setCache } from "@/lib/chat/slice-cache";
import { dropTrailingAssistantMessages } from "@/lib/chat/reconnect";
import { saveUserConfig } from "@/lib/config/actions";
import type { UserConfig } from "@/lib/config/types";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { clientTrace, createTracedFetch } from "./client-trace";

interface ChatPageProps {
  /** Server-preloaded user config (RSC) — seeds model/thinking/effort so the
   *  chat starts on the real values instead of flashing defaults. */
  initialConfig?: UserConfig;
}

export function ChatPage({ initialConfig }: ChatPageProps) {
  return <Inner initialConfig={initialConfig} />;
}

// ─── Reconnect persistence ────────────────────────────────────────────────
// The durable workflow run's id is persisted so a reloaded or backgrounded tab
// (phone lock / app switch) can re-attach to the SAME run's stream and replay
// whatever it missed. Cleared when a turn completes cleanly. Guarded so a
// private-mode / SSR environment (no localStorage) degrades to no-op.
const RUN_ID_KEY = "previously:activeRunId";

// ─── Sending window (v0.8) ────────────────────────────────────────────────
// The client keeps the full conversation for rendering, but only the LAST N
// messages travel to the server each turn. Everything earlier is already
// stored in the current slice; if the agent needs deeper context it reads it
// via recall / readSliceSummary / readTimelineWindow — it must NOT be handed
// the whole client history (that is the context-bloat + storage-accumulation
// source). The UI never trims; only the wire payload does.
const SEND_MESSAGE_WINDOW = 10; // ~5 turns of working memory

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

// ─── Inner ───────────────────────────────────────────────────────────────

function Inner({ initialConfig }: { initialConfig?: UserConfig }) {
  // ── Model / thinking / effort — reactive, persisted to config.json ─────
  // The single source of truth is memory/user/config.json (cross-device, no
  // localStorage). The RSC page preloads it (initialConfig) so there's no
  // default-flash + mount reconcile; saves still write back via server action.
  const [selectedModel, setSelectedModel] = useState(
    initialConfig?.model.provider ?? "deepseek-v4-flash",
  );
  const [thinking, setThinking] = useState(
    initialConfig?.model.thinking ?? true,
  );
  const [effort, setEffort] = useState<"low" | "medium" | "high">(
    initialConfig?.model.reasoningEffort ?? "medium",
  );

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
  // The most recent slice — its focus / open_loops seed the empty briefing.
  const [activeSlice, setActiveSlice] = useState<SliceSummary | null>(null);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>("now");
  const [historicalContent, setHistoricalContent] = useState<SliceContent | null>(null);
  // The time-travel transition currently playing (if any). While active, the
  // clock overlay covers the content area and doubles as the loading state.
  const [transition, setTransition] = useState<{
    from: string;
    to: string;
    sliceId: string;
  } | null>(null);
  // Start time of the currently loaded slice — the clock travels FROM here
  // (or from the live "now" when nothing historical is loaded).
  const [loadedSliceStart, setLoadedSliceStart] = useState<string | null>(null);
  // Resolves when the clock animation lands (see handleSelectSlice).
  const clockLandedRef = useRef<(() => void) | null>(null);

  // Persona picked from URL — server actions need it because they can't
  // access searchParams on the server side. Defaults to "personal_14".
  const persona = useMemo(() => {
    if (typeof window === "undefined") return "personal_14";
    return new URLSearchParams(window.location.search).get("persona") || "personal_14";
  }, []);

  // Load the newest slice on mount — feeds the NowPlaceholder gap anchor and
  // the send-window `loadedSliceIds`. The timeline WHEEL loads its own full
  // catalog independently (see timeline-wheel.tsx).
  useEffect(() => {
    let cancelled = false;
    getEpisodicState(persona)
      .then((data) => {
        if (cancelled) return;
        setTimelineSlices(data.recent);
        setActiveSlice(data.active);
      })
      .catch(() => {
        // silently ignore
      });
    return () => { cancelled = true; };
  }, [persona]);

  // Handle slice selection — runs the time-travel clock (which doubles as the
  // loading state) while the target content fetches in the background, then
  // swaps in the content and moves the blue selection mark.
  const handleSelectSlice = useCallback(
    async (sliceId: string, toTime?: string) => {
      if (sliceId === selectedSliceId) return; // already there

      const nowIso = new Date().toISOString();
      // Travel FROM wherever the viewer currently is (live now, or the last
      // loaded slice) TO the clicked slice.
      const from =
        selectedSliceId !== "now" && loadedSliceStart ? loadedSliceStart : nowIso;
      const to = toTime ?? (sliceId === "now" ? nowIso : from);

      const clockLanded = new Promise<void>((resolve) => {
        clockLandedRef.current = resolve;
      });
      setTransition({ from, to, sliceId });

      // Fetch in the background while the clock animates.
      let content: SliceContent | null = null;
      if (sliceId !== "now") {
        const cached = getCached(sliceId);
        content = cached
          ? cached.content
          : await getSliceContent(sliceId, persona).catch(() => null);
        if (content) setCache(sliceId, content, null);
      }

      // Land on the target: swap content + move the selection.
      await clockLanded;
      setSelectedSliceId(sliceId);
      setHistoricalContent(content);
      setLoadedSliceStart(sliceId === "now" ? null : content?.start ?? null);
      setTransition(null);
    },
    [persona, selectedSliceId, loadedSliceStart],
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

  // Refresh-resume goes through the SDK's own path: `resume: true` calls
  // resumeStream() on mount, and prepareReconnectToStreamRequest redirects it
  // to the durable run (`/api/chat/<runId>/stream?startIndex=0`), which rebuilds
  // the interrupted turn on a fresh page. Snapshot the decision ONCE at mount —
  // computing it from localStorage each render would flip false→true when a new
  // turn stores its runId, and useChat's `resume` effect would re-fire
  // resumeStream() mid-stream (a second writer → #185). Fresh visits (no run in
  // flight) stay false so a reconnect never 404s on a brand-new page.
  const [shouldResume] = useState(() => {
    const stored = readStoredRunId();
    clientTrace("mount", `storedRunId=${stored} shouldResume=${stored !== null}`);
    return stored !== null;
  });

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    resumeStream,
    setMessages,
  } = useChat({
    resume: shouldResume,
    // Clear a stale runId when a reconnect 404s ("Run not available") — the run
    // is gone, so a future reload shouldn't keep retrying it.
    onError: (err) => {
      // v0.8: log the FULL error object — WorkflowChatTransport swallows stream
      // errors and only rethrows a generic reconnect failure, so the complete
      // detail (stack / cause / status) is captured here for diagnosis.
      console.error("[useChat][onError]", formatErrorDetail(err));
      clientTrace("chat", `onError ${formatErrorDetail(err)}`);
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|Run not available/.test(msg)) {
        clearStoredRunId();
      }
    },
    onFinish: (result) =>
      clientTrace(
        "chat",
        `onFinish role=${result.message.role} parts=${(result.message.parts ?? []).length} reason=${result.finishReason}`,
      ),
    transport: new WorkflowChatTransport({
      api: "/api/chat",
      // Trace every request / chunk / swallowed stream error (see client-trace).
      fetch: createTracedFetch(fetch.bind(globalThis)),
      prepareSendMessagesRequest: (config) => {
        const sendWindow = config.messages.slice(-SEND_MESSAGE_WINDOW);
        clientTrace(
          "chat",
          `prepareSendMessagesRequest window=${sendWindow.length} model=${selectedModel} thinking=${thinking} effort=${effort} loadedSlices=${timelineSlices.length}`,
        );
        return {
          api: config.api,
          headers: config.headers,
          credentials: config.credentials,
          body: {
            // v0.8: send only the working-memory window — the rest is stored in
            // the slice and reachable via the memory tools (see SEND_MESSAGE_WINDOW).
            messages: sendWindow,
            model: selectedModel,
            thinking,
            effort,
            timezone:
              typeof Intl !== "undefined"
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : "UTC",
            loadedSliceIds: timelineSlices.map((s) => s.slice_id),
          },
        };
      },
      // Persist the durable run id + chat id the moment a turn starts, so a
      // dropped/reloaded tab can re-attach to the same run's stream.
      onChatSendMessage: (response, options) => {
        const runId = response.headers.get("x-workflow-run-id");
        clientTrace(
          "chat",
          `onChatSendMessage runId=${runId} chatId=${options.chatId} status=${response.status}`,
        );
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
      onChatEnd: () => {
        clientTrace("chat", "onChatEnd (clean turn end)");
        clearStoredRunId();
      },
      // Point any reconnect at the durable run (not the random per-mount
      // chatId) so a post-reload resume targets the real stream.
      prepareReconnectToStreamRequest: (config) => {
        const runId = readStoredRunId();
        clientTrace("reconnect", `prepareReconnectToStreamRequest runId=${runId}`);
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

  // ── Trace every status transition ────────────────────────────────────────
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (status !== prevStatusRef.current) {
      clientTrace("status", `${prevStatusRef.current} -> ${status}`);
      prevStatusRef.current = status;
    }
  }, [status]);

  // ── Reconnect on return to the foreground ────────────────────────────────
  // When the phone locks / the tab is backgrounded mid-turn, the fetch dies
  // (status → "error") even though the durable workflow keeps running. On
  // return, re-attach to the run's stream to replay what was missed. Skip when
  // the turn is still actively streaming or already finished.
  //
  // SINGLE-WRITER GUARD: the focus/visibility handler below is the ONLY manual
  // reconnect now (refresh-resume is handled by the SDK's `resume: true` above;
  // same-session drops by the transport's internal auto-reconnect). It fires
  // only when status is "error" — the previous stream is already dead, so this
  // resume can't race a live writer. The in-flight guard keeps even two rapid
  // focus events from starting two resumeStream() calls, which would otherwise
  // both write the same turn into the message list (duplicate ids → duplicate
  // keys → React "Maximum update depth exceeded" #185). We also abort any
  // still-active stream first and drop the partial turn so the startIndex-0
  // replay rebuilds it cleanly instead of appending a second copy.
  const reconnectInFlightRef = useRef(false);

  const resetPartialTurn = useCallback(() => {
    setMessages((prev) => {
      const next = dropTrailingAssistantMessages(prev);
      if (next.length !== prev.length) {
        clientTrace(
          "reconnect",
          `resetPartialTurn dropped ${prev.length - next.length} trailing assistant message(s)`,
        );
      }
      return next;
    });
  }, [setMessages]);

  const resumeWithRetry = useCallback(
    async (attempts = 3) => {
      if (reconnectInFlightRef.current) {
        clientTrace("reconnect", "resumeWithRetry skipped (already in flight)");
        return;
      }
      reconnectInFlightRef.current = true;
      clientTrace("reconnect", `resumeWithRetry start attempts=${attempts}`);
      try {
        // Kill any in-flight SDK stream before starting our own.
        await stop();
        clientTrace("reconnect", "stop() done");
        resetPartialTurn();
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            clientTrace(
              "reconnect",
              `attempt ${attempt + 1}/${attempts} resumeStream()`,
            );
            await resumeStream();
            clientTrace("reconnect", `attempt ${attempt + 1}/${attempts} SUCCEEDED`);
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            clientTrace(
              "reconnect",
              `attempt ${attempt + 1}/${attempts} FAILED ${formatErrorDetail(err)}`,
            );
            if (/404|Run not available/.test(msg)) {
              clearStoredRunId();
              return;
            }
            if (!/Failed to fetch/.test(msg) || attempt === attempts - 1) {
              if (!/Failed to fetch/.test(msg)) {
                console.warn("[chat] reconnect failed:", msg);
              }
              return;
            }
            // Transient network error — wait with backoff, then retry.
            const backoff = 1000 * (attempt + 1);
            clientTrace("reconnect", `backoff ${backoff}ms`);
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      } finally {
        reconnectInFlightRef.current = false;
        clientTrace("reconnect", "resumeWithRetry end");
      }
    },
    [resumeStream, stop, resetPartialTurn],
  );

  const attemptReconnect = useCallback(
    (source: string) => {
      const runId = readStoredRunId();
      clientTrace(
        "reconnect",
        `attemptReconnect[${source}] status=${status} runId=${runId}`,
      );
      if (!runId) return;
      // Only reconnect when the previous stream actually DIED (status "error") —
      // not while it's still streaming, finished, or a fresh POST is in flight.
      if (status !== "error") {
        clientTrace("reconnect", `  skip: status is "${status}", not "error"`);
        return;
      }
      void resumeWithRetry();
    },
    [status, resumeWithRetry],
  );

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const onVisibility = () => {
      clientTrace(
        "reconnect",
        `visibilitychange -> ${document.visibilityState}`,
      );
      if (document.visibilityState === "visible") attemptReconnect("visibility");
    };
    const onFocus = () => attemptReconnect("focus");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [attemptReconnect]);

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
    clientTrace(
      "chat",
      `handleSubmit "${message.slice(0, 80)}" model=${selectedModel} thinking=${thinking} effort=${effort} window=${SEND_MESSAGE_WINDOW} loadedSlices=${timelineSlices.length} view=${selectedSliceId}`,
    );
    if (selectedSliceId !== "now" || transition) {
      setSelectedSliceId("now");
      setHistoricalContent(null);
      setTransition(null);
      setLoadedSliceStart(null);
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
  // The "PREVIOUSLY ON" eyebrow over the travel readout — same brand mark as
  // the empty briefing's title card.
  const tBrief = useTranslations("emptyBriefing");

  return (
    <>
      {/* ── Timeline + Content — one page: wheel left, conversation right ── */}
      <div className="flex items-start">
        {/* ── Timeline wheel — sticky left, full-height, virtual-scrolled ────── */}
        <div className="sticky top-12 z-10 h-[calc(100vh-3rem)] w-48 shrink-0 border-r border-border/40 bg-background/90 backdrop-blur-md">
          <TimelineWheel
            selectedId={selectedSliceId}
            onSelect={handleSelectSlice}
          />
        </div>

        {/* ── Chat content — natural document flow ────────────────────────── */}
        <div className="min-h-[calc(100vh-12rem)] min-w-0 flex-1 pb-24">
        <AnimatePresence mode="wait">
          {transition ? (
            <motion.div
              key="travel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="relative flex items-center justify-center overflow-hidden min-h-[calc(100vh-13rem)]"
            >
              {/* Soft brand glow behind the travel readout — the same stage-light
                  as the empty briefing's title card. */}
              <div
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/10 blur-3xl"
              />
              <div className="relative flex flex-col items-center gap-3">
                <span className="font-mono text-[0.65rem] uppercase tracking-[0.35em] text-muted-foreground/60">
                  {tBrief("eyebrow")}
                </span>
                <RelativeTimeReadout
                  timestamp={transition.to}
                  from={transition.from}
                  onRollComplete={() => clockLandedRef.current?.()}
                />
              </div>
            </motion.div>
          ) : showingLive ? (
            <motion.div
              key="live"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              {allMessages.length === 0 && !isLoading ? (
                <EmptyBriefing
                  persona={persona}
                  active={activeSlice}
                  recent={timelineSlices}
                  onSend={handleSubmit}
                />
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
              )}
            </motion.div>
          ) : (
            <motion.div
              key={`slice-${selectedSliceId ?? "none"}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              <HistoricalChatView
                content={historicalContent}
                loading={false}
              />
            </motion.div>
          )}
        </AnimatePresence>
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
