"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import type { UIMessage } from "ai";
import { ChatInput } from "./chat-input";
import { useAvailableModels } from "@/hooks/use-available-models";
import { ChatSection } from "./chat-section";
import { HistoricalChatView } from "./historical-chat-view";
import { RelativeTimeReadout } from "./relative-time";
import { EmptyBriefing } from "./empty-briefing";
import { TimelineWheel } from "./timeline-wheel";
import { ResizableSplit } from "./resizable-split";
import { useTimelineOverlay } from "./timeline-overlay-context";
import { AnimatePresence, motion } from "motion/react";
import {
  getBriefingIdentity,
  getEpisodicState,
  getSliceContent,
  type SliceSummary,
  type SliceContent,
} from "@/lib/episodic/actions";
import { getCached, setCache } from "@/lib/chat/slice-cache";
import {
  decideArrival,
  type ArrivalDecision,
} from "@/lib/chat/reconnect";
import { isChatRunActive } from "@/lib/chat/actions";
import { saveUserConfig } from "@/lib/config/actions";
import type { UserConfig } from "@/lib/config/types";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { setTurnBusy } from "./turn-busy";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

interface ChatPageProps {
  /** Server-preloaded user config (RSC) — seeds the selected model so the
   *  chat starts on the real value instead of flashing defaults. */
  initialConfig?: UserConfig;
}

export function ChatPage({ initialConfig }: ChatPageProps) {
  // Mount-time arrival decision. Only the SERVER can say whether the persisted
  // run is still in flight, so this verdict is async — Inner (and therefore
  // useChat) mounts only after it lands, keeping useChat's init a synchronous,
  // once-only snapshot. Until then nothing renders (the header is outside this
  // tree, so the page chrome still shows).
  const [arrival, setArrival] = useState<ArrivalDecision | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveArrival().then((d) => {
      if (!cancelled) setArrival(d);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!arrival) return null;
  return (
    <Inner
      initialConfig={initialConfig}
      shouldResume={arrival.shouldResume}
      initialMessages={arrival.initialMessages}
    />
  );
}

/**
 * The one-shot arrival verdict, side effects included. The rule: the live view
 * restores ONLY in-flight work.
 *
 * - The persisted run is still pending/running → genuine reconnect: keep the
 *   working conversation (the replay rebuilds its trailing partial turn).
 * - Anything else (no run, terminal run) → fresh arrival: CLEAR the stash so
 *   completed conversation never resurrects in the live view — it already
 *   lives in its slice on the timeline, and the arrival briefing carries the
 *   continuity ("上次聊到", suggested follow-ups).
 *
 * A failed status check (offline / server down) fails neutral: open blank but
 * DON'T clear the stash, so the next visit can retry the verdict.
 */
async function resolveArrival(): Promise<ArrivalDecision> {
  const runId = readStoredRunId();
  let active = false;
  if (runId) {
    try {
      active = await isChatRunActive(runId);
    } catch {
      return { shouldResume: false, initialMessages: [] };
    }
  }
  if (active) {
    return decideArrival(true, readStoredMessages());
  }
  clearStoredRunId();
  clearStoredChatId();
  clearStoredMessages();
  return decideArrival(false, []);
}

// ─── Reconnect persistence ────────────────────────────────────────────────
// The durable workflow run's id is persisted so a reloaded or backgrounded tab
// (phone lock / app switch) can re-attach to the SAME run's stream and replay
// whatever it missed — but only while the run is actually in flight (the
// mount-time arrival decision asks the server, see resolveArrival). Cleared on
// a clean turn end and on any fresh arrival. Guarded so a private-mode / SSR
// environment (no localStorage) degrades to no-op.
const RUN_ID_KEY = "previously:activeRunId";
const CHAT_ID_KEY = "previously:chatId";

// ─── Sending window (v0.8) ────────────────────────────────────────────────
// The client keeps the full conversation for rendering, but only the LAST N
// messages travel to the server each turn. Everything earlier is already
// stored in the current slice; if the agent needs deeper context it gets it
// via recall / readSlice — it must NOT be handed
// the whole client history (that is the context-bloat + storage-accumulation
// source). The UI never trims; only the wire payload does.
const SEND_MESSAGE_WINDOW = 10; // ~5 turns of working memory
/** Cap the persisted conversation so a long session can't overflow localStorage. */
const PERSIST_MESSAGE_CAP = 200;

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

function clearStoredChatId(): void {
  try {
    localStorage.removeItem(CHAT_ID_KEY);
  } catch {
    /* best-effort */
  }
}

// ─── Conversation persistence (official single-turn resume pattern) ───────
// The chat-session-modeling / resumable-streams docs: the client owns the
// conversation and restores it via `initialMessages` when a run is resumed, so
// the stream resume only reconciles the LAST message instead of replaying the
// whole run into an empty store (which pushes a full copy per chunk →
// duplicated, growing message list). We persist the rendered UIMessage[] to
// localStorage. A fresh arrival CLEARS the stash (see resolveArrival) — the
// live view never resurrects completed conversation.
const STORED_MESSAGES_KEY = "previously:messages";

function readStoredMessages(): UIMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORED_MESSAGES_KEY);
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function writeStoredMessages(messages: UIMessage[]): void {
  try {
    localStorage.setItem(STORED_MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    /* private mode — persistence is best-effort */
  }
}

function clearStoredMessages(): void {
  try {
    localStorage.removeItem(STORED_MESSAGES_KEY);
  } catch {
    /* best-effort */
  }
}

/** Read a File as a data URL — the transport for image file parts. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─── Inner ───────────────────────────────────────────────────────────────

function Inner({
  initialConfig,
  shouldResume,
  initialMessages,
}: {
  initialConfig?: UserConfig;
  /** The mount-time arrival verdict (resolveArrival) — see ChatPage. */
  shouldResume: boolean;
  initialMessages: UIMessage[];
}) {
  // ── Model selection — reactive, persisted to config.json ─────────────
  // The single source of truth is memory/user/config.json (cross-device, no
  // localStorage). The RSC page preloads it (initialConfig) so there's no
  // default-flash + mount reconcile; saves still write back via server action.
  // Thinking/effort are NOT client state: the server pins thinking ON at low
  // effort for every turn (see start-turn.ts).
  const locale = useLocale();
  const [selectedModel, setSelectedModel] = useState(
    initialConfig?.model.provider ?? "deepseek-v4-flash",
  );

  // The live catalog (shared fetch with ModelSelector) — gates the image
  // attach control on the selected model's vision capability.
  const availableModels = useAvailableModels();
  const visionSupported =
    availableModels.find((m) => m.id === selectedModel)?.supportsVision ??
    false;

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    void saveUserConfig({
      model: { provider: modelId },
    });
  }, []);

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);

  // ── Timeline state ──────────────────────────────────────────────────────
  const [timelineSlices, setTimelineSlices] = useState<SliceSummary[]>([]);
  // The most recent slice — its focus / open_loops seed the empty briefing.
  const [activeSlice, setActiveSlice] = useState<SliceSummary | null>(null);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>("now");
  // The slice the user just clicked — drives the wheel's selection glow
  // IMMEDIATELY (before the time-travel transition lands), so the marker
  // doesn't lag behind the click by the roll's duration.
  const [pendingSliceId, setPendingSliceId] = useState<string | null>(null);
  // The user's display name — feeds the "PREVIOUSLY ON {name}" eyebrow over
  // the time-travel readout (falls back to "YOU" until it resolves).
  const [briefingName, setBriefingName] = useState<string>("");
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
    // Resolve the display name for the "PREVIOUSLY ON {name}" eyebrow.
    getBriefingIdentity(persona)
      .then((id) => {
        if (!cancelled) setBriefingName(id.name);
      })
      .catch(() => {});
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
      // Light the wheel's selection marker on the clicked slice right away —
      // don't wait for the roll to land.
      setPendingSliceId(sliceId);

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
      setPendingSliceId(null);
      setHistoricalContent(content);
      setLoadedSliceStart(sliceId === "now" ? null : content?.start ?? null);
      setTransition(null);
    },
    [persona, selectedSliceId, loadedSliceStart],
  );

  // Refresh-resume goes through the SDK's own path: `resume: true` calls
  // resumeStream() on mount, and prepareReconnectToStreamRequest redirects it
  // to the durable run (`/api/chat/<runId>/stream?startIndex=0`), which rebuilds
  // the interrupted turn on a fresh page. The `shouldResume` / `initialMessages`
  // verdict arrives as PROPS from ChatPage's one-shot arrival decision (the
  // server is the only authority on whether the run is still in flight) — never
  // recompute it from localStorage here: a mid-stream flip would re-fire
  // useChat's `resume` effect (a second writer → #185), and an unstable
  // messages array itself trips React #185.
  const {
    messages,
    sendMessage,
    status,
    stop,
    regenerate,
    error,
  } = useChat({
    // v5 SDK: initial conversation state is passed as `messages` (ChatInit).
    messages: initialMessages,
    resume: shouldResume,
    // v0.8: throttle the UI updates. The resume replay (and heavy streaming)
    // delivers chunks rapidly; each write() does setStatus + replaceMessage via
    // useSyncExternalStore, and the per-chunk re-render storm trips React's
    // #185 "Maximum update depth exceeded". This is the AI SDK's documented fix
    // (ai-sdk.dev/docs/troubleshooting/react-maximum-update-depth-exceeded).
    throttle: 50,
    // Clear a stale runId when a reconnect 404s ("Run not available") — the run
    // is gone, so a future reload shouldn't keep retrying it.
    onError: (err) => {
      console.error("[useChat][onError]", formatErrorDetail(err));
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|Run not available/.test(msg)) {
        clearStoredRunId();
      }
    },
    // Flush the completed conversation the moment a turn ends, so a refresh
    // right after finishing never restores a stale copy. The debounced effect
    // below only writes after a quiet period — during continuous streaming it
    // may not have written at all, and onChatEnd clears the runId immediately,
    // so the gap between "finished" and "persisted" would otherwise lose the
    // just-finished reply.
    onFinish: ({ messages: finished }) => {
      writeStoredMessages(finished.slice(-PERSIST_MESSAGE_CAP));
    },
    transport: new WorkflowChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: (config) => {
        const sendWindow = config.messages.slice(-SEND_MESSAGE_WINDOW);
        return {
          api: config.api,
          headers: config.headers,
          credentials: config.credentials,
          body: {
            // v0.8: send only the working-memory window — the rest is stored in
            // the slice and reachable via the memory tools (see SEND_MESSAGE_WINDOW).
            messages: sendWindow,
            model: selectedModel,
            timezone:
              typeof Intl !== "undefined"
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : "UTC",
            // UI locale — the turn's relative-time annotations follow it.
            locale,
            loadedSliceIds: timelineSlices.map((s) => s.slice_id),
            // The regenerate action re-runs the previous user message — the
            // server must NOT re-append it to the slice (and records an
            // interaction_regenerate fitness signal). See TurnInput.regenerate.
            ...(config.trigger === "regenerate-message"
              ? { regenerate: true }
              : {}),
          },
        };
      },
      // Persist the durable run id + chat id the moment a turn starts, so a
      // dropped/reloaded tab can re-attach to the same run's stream.
      onChatSendMessage: (response, options) => {
        const runId = response.headers.get("x-workflow-run-id");
        if (runId) {
          writeStoredRunId(runId);
          try {
            localStorage.setItem(CHAT_ID_KEY, options.chatId);
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

  // ── Persist the conversation (debounced) so a refresh restores it via
  // `initialMessages`.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    const id = setTimeout(() => {
      writeStoredMessages(messages.slice(-PERSIST_MESSAGE_CAP));
    }, 100);
    return () => clearTimeout(id);
  }, [messages]);

  const isStreaming = status === "streaming";
  const isLoading = status === "submitted" || isStreaming;

  // Publish the in-flight state so the header can disable the settings entry
  // mid-turn (engine/model changes must not land while a call is running).
  useEffect(() => {
    setTurnBusy(isLoading);
    return () => setTurnBusy(false);
  }, [isLoading]);

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
    const last = messages[messages.length - 1];
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
  }, [messages, t]);

  const handleSubmit = async (message: string, images: File[]) => {
    if (selectedSliceId !== "now" || transition) {
      setSelectedSliceId("now");
      setHistoricalContent(null);
      setTransition(null);
      setPendingSliceId(null);
      setLoadedSliceStart(null);
    }
    setLastUserMessageAt(new Date().toISOString());
    // Images travel as AI SDK file parts (data URLs) — convertToModelMessages
    // on the server maps them to the provider's image inputs. The files are
    // already downscaled/re-encoded by use-image-attachments.
    const fileParts = await Promise.all(
      images.map(async (file) => ({
        type: "file" as const,
        mediaType: file.type,
        filename: file.name,
        url: await fileToDataUrl(file),
      })),
    );
    const parts: UIMessage["parts"] = [
      ...fileParts,
      ...(message ? [{ type: "text" as const, text: message }] : []),
    ];
    sendMessage({ role: "user", parts });
    // v0.7b: self-evolution runs INLINE inside housekeeping (the turn's stream
    // carries data-evolution chunks) — no separate evolution request here.
    // v0.9: buildStream folds those chunks into the housekeeping card, so the
    // client needs no evolution-specific state at all.
  };

  // ── Regenerate: re-answer the last user message. The SDK truncates the
  // rejected assistant message locally and re-requests with trigger
  // "regenerate-message" (which prepareSendMessagesRequest turns into the
  // body's regenerate flag). Only the LAST assistant message gets the button
  // (ChatSection gates), and never mid-turn.
  const handleRegenerate = useCallback(
    (messageId: string) => {
      if (status !== "ready") return;
      void regenerate({ messageId });
    },
    [regenerate, status],
  );

  // ── Stop: abort the local stream AND drop the stored run id, so a reload
  // never resurrects a turn the user deliberately cut off (onChatEnd only
  // fires on a finish chunk, which an abort never receives). The durable run
  // itself keeps writing memory server-side — the interruption is reported as
  // a fitness signal, best-effort.
  const handleStop = useCallback(() => {
    void stop();
    clearStoredRunId();
    fetch("/api/episodic/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "interaction_interrupt" }),
      keepalive: true,
    }).catch(() => {
      /* instrumentation — never surface */
    });
  }, [stop]);

  // Hydration guard: the persisted conversation only exists client-side, so the
  // server renders the empty state. Keep the FIRST client render matching the
  // server HTML (empty), then reveal the restored messages after hydration —
  // otherwise React throws a hydration mismatch (server empty vs client
  // restored). Once hydrated the flag is irrelevant.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const showingLive = selectedSliceId === "now";
  // The "PREVIOUSLY ON" eyebrow over the travel readout — same brand mark as
  // the empty briefing's title card.
  const tBrief = useTranslations("emptyBriefing");
  // Timeline expand — toggled from the header / mini spine / desktop expand
  // button; collapses on slice select. The same left timeline widens in place
  // over the content (no separate drawer), with a blur mask over what's behind.
  const {
    open: timelineOpen,
    close: closeTimeline,
  } = useTimelineOverlay();

  // Picking a slice in the timeline collapses it so the time-travel transition
  // plays against the content revealed behind.
  const handleTimelineSelect = useCallback(
    (sliceId: string, start?: string) => {
      handleSelectSlice(sliceId, start);
      closeTimeline();
    },
    [handleSelectSlice, closeTimeline],
  );
  return (
    <>
      {/* ── Timeline + Content — a split view: timeline left (fixed width:
           full wheel on desktop / mini spine on phones), conversation right.
           Expanding widens the SAME timeline over the content with a blur mask
           (no separate drawer). The right panel scrolls internally. */}
      <ResizableSplit
        expanded={timelineOpen}
        left={
          <div className="flex h-full flex-col pl-2 md:pl-5">
            <div className="min-h-0 flex-1">
              <TimelineWheel
                selectedId={selectedSliceId}
                pendingId={pendingSliceId}
                onSelect={handleTimelineSelect}
              />
            </div>
          </div>
        }
        right={
        <AnimatePresence mode="wait">
          {transition ? (
            <motion.div
              key="travel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="relative flex items-center justify-center overflow-hidden min-h-full"
            >
              {/* Soft brand glow behind the travel readout — the same stage-light
                  as the empty briefing's title card. */}
              <div
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/10 blur-3xl"
              />
              <div className="relative flex flex-col items-center gap-3">
                <span className="font-mono text-[0.65rem] uppercase tracking-[0.35em] text-muted-foreground/60">
                  {tBrief("eyebrowWithName", { name: briefingName || tBrief("fallbackName") })}
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
              className="h-full"
            >
              {(!hydrated || (messages.length === 0 && !isLoading)) ? (
                <EmptyBriefing
                  persona={persona}
                  active={activeSlice}
                  recent={timelineSlices}
                  onSend={(msg) => void handleSubmit(msg, [])}
                />
              ) : (
                <div className="mx-auto max-w-5xl xl:max-w-7xl pl-0 pr-4 sm:pr-6 lg:pr-8 min-h-full pb-36">
                  {/* No left padding — the timeline itself is the separator.
                      pb-36 = safe area clearing the fixed bottom input bar. */}
                  <ChatSection
                    messages={messages}
                    isStreaming={isStreaming}
                    isLoading={isLoading}
                    error={error}
                    lastUserMessageAt={lastUserMessageAt}
                    onRegenerate={handleRegenerate}
                  />
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
        }>
      </ResizableSplit>

      {/* ── Fixed bottom bar ────────────────────────────────────────────── */}
      {/* While the timeline is expanded (z-20 panel + translucent blur mask),
          fade the input out — otherwise the card ghosts through the mask. */}
      <div
        className={`fixed bottom-0 inset-x-0 z-10 transition-opacity duration-300 ${
          timelineOpen ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
          <div className="mx-auto w-full md:max-w-2xl px-4 sm:px-6 lg:px-8">
            <ChatInput
              onSubmit={handleSubmit}
              isLoading={isLoading}
              onStop={handleStop}
              persona={persona}
              visionEnabled={visionSupported}
              currentModelId={selectedModel}
              onModelChange={handleModelChange}
            />
          </div>
        </div>
      </div>
    </>
  );
}
