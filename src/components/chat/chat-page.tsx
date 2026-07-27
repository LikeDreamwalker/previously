"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import type { UIMessage } from "ai";
import { ChatInput } from "./chat-input";
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
import { useTranslations } from "next-intl";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

interface ChatPageProps {
  children: React.ReactNode;
}

export function ChatPage({ children }: ChatPageProps) {
  return <Inner>{children}</Inner>;
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
  const [settings] = useState(() => ({
    model: getClientSetting("PREVIOUSLY_MODEL", "deepseek-v4-flash"),
    thinking: getClientSetting("PREVIOUSLY_THINKING", "true") !== "false",
    effort: getClientSetting("PREVIOUSLY_EFFORT", "medium"),
  }));

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);
  const [evolutionState, setEvolutionState] = useState<EvolutionState | null>(null);
  const evolutionAbortRef = useRef<AbortController | null>(null);

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

  const { messages, sendMessage, status, stop, error } = useChat({
    resume: false,
    transport: new WorkflowChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: (config) => ({
        api: config.api,
        headers: config.headers,
        credentials: config.credentials,
        body: {
          messages: config.messages,
          ...settings,
          timezone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : "UTC",
          loadedSliceIds: timelineSlices.map((s) => s.slice_id),
        },
      }),
      onChatSendMessage: (_response) => {},
      onChatEnd: () => {},
      prepareReconnectToStreamRequest: (config) => config,
    }),
  });

  const isStreaming = status === "streaming" || demoStreaming;
  const isLoading = status === "submitted" || isStreaming;

  const allMessages = useMemo(() => {
    if (demoMessages.length > 0) return demoMessages;
    return messages;
  }, [messages, demoMessages]);

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

  // Abort in-flight evolution on unmount
  useEffect(() => {
    return () => {
      evolutionAbortRef.current?.abort();
    };
  }, []);

  const handleSubmit = (message: string) => {
    if (selectedSliceId !== "now") {
      setSelectedSliceId("now");
      setHistoricalContent(null);
    }
    setLastUserMessageAt(new Date().toISOString());
    sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
    if (!demoStreaming) {
      fireEvolution();
    }
  };

  const fireEvolution = useCallback(async () => {
    evolutionAbortRef.current?.abort();
    const controller = new AbortController();
    evolutionAbortRef.current = controller;

    setEvolutionState({ running: true, step: "reading" });

    try {
      const res = await fetch("/api/evolution", {
        method: "POST",
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setEvolutionState({
          running: false,
          error: `Server returned ${res.status}`,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const chunk = JSON.parse(trimmed.slice(6)) as
              | { type?: string; data?: EvolutionState }
              | undefined;
            if (chunk?.type === "data-evolution" && chunk.data) {
              setEvolutionState(chunk.data);
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setEvolutionState({
        running: false,
        error: err instanceof Error ? err.message : "Evolution request failed",
      });
    }
  }, []);

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
                gapAnchor={timelineSlices[timelineSlices.length - 1]?.start ?? null}
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
            />
          </div>
        </div>
      </div>
    </>
  );
}
