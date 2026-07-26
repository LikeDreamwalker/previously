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
import { PreviouslyBar } from "./previously-bar";
import { HistoricalChatView } from "./historical-chat-view";
import {
  getEpisodicState,
  getMoreSlices,
  getSliceContent,
  type SliceSummary,
  type SliceContent,
} from "@/lib/episodic/actions";
import { getCached, setCache } from "@/lib/chat/slice-cache";

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

  // Load initial timeline data on mount
  useEffect(() => {
    let cancelled = false;
    getEpisodicState()
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
  }, []);

  // Load more slices
  const handleLoadMore = useCallback(async () => {
    if (timelineLoadingMore || !timelineHasMore) return;
    const oldest = timelineSlices[timelineSlices.length - 1];
    if (!oldest) return;

    setTimelineLoadingMore(true);
    try {
      const data = await getMoreSlices(oldest.start, 10);
      setTimelineSlices((prev) => [...prev, ...data.slices]);
      setTimelineHasMore(data.hasMore);
    } catch {
      // silently fail
    } finally {
      setTimelineLoadingMore(false);
    }
  }, [timelineLoadingMore, timelineHasMore, timelineSlices]);

  // Handle slice selection
  const handleSelectSlice = useCallback(
    async (sliceId: string) => {
      setSelectedSliceId(sliceId);

      if (sliceId === "now") {
        setHistoricalContent(null);
        return;
      }

      const cached = getCached(sliceId);
      if (cached) {
        setHistoricalContent(cached.content);
        return;
      }

      setHistoricalLoading(true);
      try {
        const content = await getSliceContent(sliceId);
        setHistoricalContent(content);
        if (content) {
          setCache(sliceId, content, null);
        }
      } catch {
        setHistoricalContent(null);
      } finally {
        setHistoricalLoading(false);
      }
    },
    [],
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

      {/* ── Sticky timeline — snaps below AppHeader (fixed h-12) ────────── */}
      <div className="sticky top-12 z-10 bg-background">
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
      <div className="pb-32">
        {showingLive ? (
          <div className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8">
            <ChatSection
              messages={allMessages}
              isStreaming={isStreaming}
              isLoading={isLoading}
              error={error}
              lastUserMessageAt={lastUserMessageAt}
            />
            <LoopWatcher messages={messages} />
          </div>
        ) : (
          <HistoricalChatView
            content={historicalContent}
            loading={historicalLoading}
          />
        )}
      </div>

      {/* ── Fixed bottom bar ────────────────────────────────────────────── */}
      <div className="fixed bottom-0 inset-x-0 z-10">
        <PreviouslyBar evolutionState={evolutionState} />
        <div className="pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))] bg-background">
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
