"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { UIMessage } from "ai";
import type { VirtuosoHandle } from "react-virtuoso";
import { ChatInput } from "./chat-input";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  UnifiedChatStream,
  type ChatStreamItem,
  type LiveStreamItem,
} from "./unified-chat-stream";
import { RelativeTimeReadout } from "./relative-time";
import { EmptyBriefing } from "./empty-briefing";
import { AnimatePresence, motion } from "motion/react";
import {
  getArrivalState,
  getBriefingIdentity,
  getEpisodicState,
  getTimelineCatalog,
  type ArrivalState,
  type SliceSummary,
} from "@/lib/episodic/actions";
import {
  decideArrival,
  type ArrivalDecision,
} from "@/lib/chat/reconnect";
import {
  buildHistoryItems,
  type ResumeBlock,
} from "@/lib/chat/stream-items";
import { useSliceStream } from "@/hooks/use-slice-stream";
import { isChatRunActive } from "@/lib/chat/actions";
import { saveUserConfig } from "@/lib/config/actions";
import type { UserConfig } from "@/lib/config/types";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { setTurnBusy } from "./turn-busy";
import { registerSliceJumpHandler, takePendingSliceJump } from "@/lib/chat/slice-jump";
import { parseAtParam, stripAtParam } from "@/lib/chat/mode-switch";
import { setViewportSlice } from "@/lib/chat/viewport-slice";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

interface ChatPageProps {
  /** Server-preloaded user config (RSC) — seeds the selected model so the
   *  chat starts on the real value instead of flashing defaults. */
  initialConfig?: UserConfig;
}

/** The mount-time verdict: the useChat half (reconnect) plus the arrival gate
 *  half (§2 resume-vs-briefing) plus the persona both were resolved under. */
interface MountVerdict extends ArrivalDecision {
  arrival: ArrivalState;
  persona: string;
}

export function ChatPage({ initialConfig }: ChatPageProps) {
  // Mount-time arrival decision. Only the SERVER can say whether the persisted
  // run is still in flight and whether the newest slice is still alive, so
  // this verdict is async — Inner (and therefore useChat) mounts only after it
  // lands, keeping useChat's init a synchronous, once-only snapshot. Until
  // then nothing renders (the header is outside this tree, so the page chrome
  // still shows).
  const [verdict, setVerdict] = useState<MountVerdict | null>(null);
  useEffect(() => {
    // Persona comes from the URL — server actions can't read searchParams.
    const persona =
      new URLSearchParams(window.location.search).get("persona") || "user";
    let cancelled = false;
    resolveArrival(persona).then((d) => {
      if (!cancelled) setVerdict({ ...d, persona });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!verdict) return null;
  return (
    <Inner
      initialConfig={initialConfig}
      persona={verdict.persona}
      shouldResume={verdict.shouldResume}
      initialMessages={verdict.initialMessages}
      arrival={verdict.arrival}
    />
  );
}

/**
 * The one-shot arrival verdict, side effects included (v0.10 §1.7/§2).
 *
 * - The persisted run is still pending/running → genuine reconnect: keep the
 *   working conversation from the stash (the replay rebuilds its trailing
 *   partial turn). The stash's ONLY job is this in-flight reconnection.
 * - Anything else (no run, terminal run) → drop the stash: continuity is now
 *   restored from the SLICE — getArrivalState says whether the newest slice
 *   is still inside the idle gap, and if so its turns re-enter the message
 *   stream directly (cross-device, no localStorage involved). A dead slice
 *   leaves the arrival briefing to carry the continuity.
 *
 * A failed status check (offline / server down) fails neutral: open blank but
 * DON'T clear the stash, so the next visit can retry the verdict.
 */
async function resolveArrival(
  persona: string,
): Promise<ArrivalDecision & { arrival: ArrivalState }> {
  const runId = readStoredRunId();
  let active = false;
  let statusCheckFailed = false;
  if (runId) {
    try {
      active = await isChatRunActive(runId);
    } catch {
      statusCheckFailed = true;
    }
  }
  // The arrival gate is independent of the run verdict — fetched in parallel
  // spirit (after the run check so a hanging status call doesn't delay it is
  // NOT a goal; correctness of the neutral-fail path is).
  const arrival = await getArrivalState(persona).catch(
    (): ArrivalState => ({ mode: "briefing" }),
  );
  if (statusCheckFailed) {
    return { shouldResume: false, initialMessages: [], arrival };
  }
  if (active) {
    return { ...decideArrival(true, readStoredMessages()), arrival };
  }
  clearStoredRunId();
  clearStoredChatId();
  clearStoredMessages();
  return { ...decideArrival(false, []), arrival };
}

// ─── Reconnect persistence ────────────────────────────────────────────────
// The durable workflow run's id is persisted so a reloaded or backgrounded tab
// (phone lock / app switch) can re-attach to the SAME run's stream and replay
// whatever it missed — but only while the run is actually in flight (the
// mount-time arrival decision asks the server, see resolveArrival). Cleared on
// a clean turn end and whenever the run turns out terminal. Guarded so a
// private-mode / SSR environment (no localStorage) degrades to no-op.
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

/** Virtuoso prepend pattern: the list's absolute index origin. Big enough
 *  that any realistic history depth of prepended pages stays positive. */
const FIRST_ITEM_INDEX_BASE = 100_000;

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
// localStorage. Since v0.10 this stash serves ONLY the in-flight reconnect —
// completed conversation is restored from its slice (see resolveArrival).
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

/**
 * The stream index where a slice's block begins: its seam when one is
 * rendered above it (so the jump lands with the seam in view), else its
 * resume banner, else its first turn.
 */
export function sliceStartIndex(
  items: readonly ChatStreamItem[],
  sliceId: string,
): number | null {
  const seamIdx = items.findIndex(
    (i) => i.kind === "seam" && i.key === `seam-${sliceId}`,
  );
  if (seamIdx >= 0) return seamIdx;
  const idx = items.findIndex(
    (i) =>
      (i.kind === "history-turn" && i.sliceId === sliceId) ||
      (i.kind === "resume-banner" && i.key === `resume-${sliceId}`),
  );
  return idx >= 0 ? idx : null;
}

// ─── Inner ───────────────────────────────────────────────────────────────

function Inner({
  initialConfig,
  persona,
  shouldResume,
  initialMessages,
  arrival,
}: {
  initialConfig?: UserConfig;
  /** Persona from the URL — server actions can't read searchParams. */
  persona: string;
  /** The mount-time arrival verdict (resolveArrival) — see ChatPage. */
  shouldResume: boolean;
  initialMessages: UIMessage[];
  /** The §2 arrival gate — resume restores the alive slice's turns. */
  arrival: ArrivalState;
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
  // The slice the stream is currently landed on ("now" = the live bottom) —
  // the jump guard and the submit snap-back read it.
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>("now");
  // The user's display name — feeds the "PREVIOUSLY ON {name}" eyebrow over
  // the time-travel readout (falls back to "YOU" until it resolves).
  const [briefingName, setBriefingName] = useState<string>("");
  // The time-travel transition currently playing (if any) — an overlay that
  // covers the stream and doubles as the loading state while older pages are
  // paged in beneath it.
  const [transition, setTransition] = useState<{
    from: string;
    to: string;
    sliceId: string;
  } | null>(null);
  // Resolves when the clock animation lands (see handleSelectSlice).
  const clockLandedRef = useRef<(() => void) | null>(null);

  // ── Unified message stream (v0.10 §1/§2) ──────────────────────────────
  // The resume block: when the newest slice is still alive (and we're not
  // re-attaching to an in-flight run whose stash already carries those turns),
  // its turns re-enter the stream from the slice itself. The historical
  // paging cursor is pinned BEFORE that slice so it never double-renders.
  const [resumeBlock] = useState<ResumeBlock | null>(() =>
    arrival.mode === "resume" && !shouldResume
      ? {
          sliceId: arrival.sliceId,
          start: arrival.start,
          focus: arrival.focus,
          turns: arrival.turns,
        }
      : null,
  );
  const [streamCursor] = useState<string | null>(() =>
    arrival.mode === "resume" ? arrival.start : null,
  );
  const stream = useSliceStream(persona, streamCursor);

  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_INDEX_BASE);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // The time of the item currently at the top of the viewport (reported by the
  // stream) — the travel clock rolls FROM where the viewer actually is.
  const topTimeRef = useRef<string | null>(null);

  // Page one older slice page in and shift the absolute index origin by the
  // exact item delta so the viewport doesn't move (Virtuoso prepend pattern).
  const { loadOlder, loadingOlder } = stream;
  const pageOlder = useCallback(async () => {
    const added = await loadOlder();
    if (added > 0) setFirstItemIndex((f) => f - added);
  }, [loadOlder]);

  // startReached while a page is in flight (incl. the initial fill) would
  // no-op through loadOlder's guard — re-fire once it settles so a short list
  // keeps filling the viewport without requiring a scroll wiggle.
  const startReachedPendingRef = useRef(false);
  const handleStartReached = useCallback(() => {
    if (loadingOlder) {
      startReachedPendingRef.current = true;
      return;
    }
    void pageOlder();
  }, [loadingOlder, pageOlder]);
  useEffect(() => {
    if (!loadingOlder && startReachedPendingRef.current) {
      startReachedPendingRef.current = false;
      void pageOlder();
    }
  }, [loadingOlder, pageOlder]);

  // Load the newest slice on mount — feeds the empty briefing. (The 3D
  // timeline and its wheel fallback load their own catalog on /timeline.)
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

  // ── The stream's item model: [history slice blocks …, resume block, live] ─
  const handleRegenerate = useCallback(
    (messageId: string) => {
      if (status !== "ready") return;
      void regenerate({ messageId });
    },
    [regenerate, status],
  );

  const liveItems = useMemo<LiveStreamItem[]>(() => {
    const lastMessage = messages[messages.length - 1];
    // Regenerate re-answers the last user message — only meaningful on the
    // LATEST assistant reply (and never mid-stream; ChatMessage also gates).
    const lastAssistantId = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")?.id;
    const nowIso = new Date().toISOString();
    return messages.map((message, index) => ({
      kind: "live",
      // Index-suffixed key: if a reconnect ever delivers a duplicated message
      // id (the same turn written twice by concurrent streams), the key stays
      // unique — React's duplicate-key reconciliation can otherwise loop into
      // "Maximum update depth exceeded" (#185).
      key: `${message.id}-${index}`,
      message,
      timeIso: nowIso,
      isStreaming: message.id === lastMessage?.id && isStreaming,
      startedAt:
        message.id === lastMessage?.id
          ? (lastUserMessageAt ?? undefined)
          : undefined,
      onRegenerate:
        message.id === lastAssistantId
          ? () => handleRegenerate(message.id)
          : undefined,
    }));
  }, [messages, isStreaming, lastUserMessageAt, handleRegenerate]);

  // ── Arrival forms (v0.10 §1.2 Rev 2): the stream is ALWAYS the view — no
  // "briefing page vs stream" split. Briefing mode seats the EmptyBriefing
  // content as a stream-tail card (history pages in above it); resume mode
  // restores the alive slice's turns under a banner. The standalone
  // full-screen briefing survives ONLY for an empty memory (not one slice),
  // known once the first page settles (initialLoaded).
  const emptyMemory =
    arrival.mode === "briefing" &&
    stream.initialLoaded &&
    stream.slices.length === 0 &&
    !stream.hasMore &&
    messages.length === 0;
  const showBriefingCard = arrival.mode === "briefing" && !emptyMemory;
  // A mount-time "now" stamp — the briefing tail item's time anchor for the
  // time indicator / rail.
  const [briefingTimeIso] = useState(() => new Date().toISOString());

  const items = useMemo<ChatStreamItem[]>(() => {
    const tail: ChatStreamItem[] = showBriefingCard
      ? [{ kind: "briefing", key: "briefing", timeIso: briefingTimeIso }]
      : [];
    return [
      ...buildHistoryItems(stream.slices, resumeBlock),
      ...tail,
      ...liveItems,
    ];
  }, [stream.slices, resumeBlock, liveItems, showBriefingCard, briefingTimeIso]);
  // Refs for the async jump path (scrollToIndex after paging lands).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Virtuoso's scrollToIndex takes the DATA-relative index (0-based into
  // `items`) — the firstItemIndex shift only applies to the indexes Virtuoso
  // REPORTS (rangeChanged / itemContent), and a shifted index here gets
  // clamped to the last item (a silent no-op jump).
  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: itemsRef.current.length - 1,
      align: "end",
    });
  }, []);

  const handleSubmit = async (message: string, images: File[]) => {
    // Sending snaps back to the present: the jump target is cleared and the
    // stream follows the new turn to the bottom.
    setSelectedSliceId("now");
    setTransition(null);
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
    requestAnimationFrame(scrollToBottom);
    // v0.7b: self-evolution runs INLINE inside housekeeping (the turn's stream
    // carries data-evolution chunks) — no separate evolution request here.
    // v0.9: buildStream folds those chunks into the housekeeping card, so the
    // client needs no evolution-specific state at all.
  };

  // ── Stop means STOP: abort the local stream, cancel the durable run
  // server-side (no further steps, no recorded agent reply — the slice keeps
  // the already-persisted user turn, "a question without an answer"), drop
  // the stored run id so a reload never resurrects a turn the user cut off
  // (onChatEnd only fires on a finish chunk, which an abort never receives),
  // and report the interruption as a fitness signal. All best-effort.
  const handleStop = useCallback(() => {
    const runId = readStoredRunId();
    void stop();
    clearStoredRunId();
    if (runId) {
      fetch(`/api/chat/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {
        /* best-effort — the local abort already stopped the UI */
      });
    }
    fetch("/api/episodic/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "interaction_interrupt" }),
      keepalive: true,
    }).catch(() => {
      /* instrumentation — never surface */
    });
  }, [stop]);

  // The unified stream replaced the separate historical view (v0.10 §1): a
  // slice jump (search palette, references bar, `?at=`) pages the target slice
  // into the stream (the time-travel clock covers the loading) and
  // scroll-lands on its seam. "now" lands at the bottom.
  const tHist = useTranslations("chat.history");

  // The travel clock's TARGET time: producers rarely know the slice's start
  // (the gone-from-home wheel was the only one that passed it), so resolve it
  // — loaded stream window, the recent-summaries catalog, the resume block,
  // else one catalog fetch. Unknown target → the clock just holds (to = from).
  const resolveSliceStart = useCallback(
    async (sliceId: string): Promise<string | null> => {
      const known =
        stream.slices.find((s) => s.id === sliceId)?.start ??
        timelineSlices.find((s) => s.slice_id === sliceId)?.start;
      if (known) return known;
      if (resumeBlock?.sliceId === sliceId) return resumeBlock.start;
      try {
        const catalog = await getTimelineCatalog();
        return catalog.find((e) => e.id === sliceId)?.start ?? null;
      } catch {
        return null;
      }
    },
    [stream.slices, timelineSlices, resumeBlock],
  );

  const handleSelectSlice = useCallback(
    async (sliceId: string, toTime?: string) => {
      if (sliceId === selectedSliceId && !transition) return; // already there

      const nowIso = new Date().toISOString();
      // Travel FROM where the viewer actually is (the top item's time) — the
      // clock's reverse-tick reads like the stream rewinding.
      const from = topTimeRef.current ?? nowIso;
      const to =
        toTime ??
        (sliceId === "now"
          ? nowIso
          : ((await resolveSliceStart(sliceId)) ?? from));

      const clockLanded = new Promise<void>((resolve) => {
        clockLandedRef.current = resolve;
      });
      setTransition({ from, to, sliceId });

      // Page backwards beneath the clock until the target slice is in the
      // stream window (the resume slice is always "loaded" — it's the block
      // right above the live turns).
      let found = true;
      if (sliceId !== "now" && sliceId !== resumeBlock?.sliceId) {
        found = await stream.loadUntilSlice(sliceId, (added) => {
          if (added > 0) setFirstItemIndex((f) => f - added);
        });
      }

      await clockLanded;
      setTransition(null);

      if (!found) {
        // The catalog exhausted before the target — an honest miss, not a
        // fake landing.
        toast.error(tHist("notFound"));
        return;
      }

      setSelectedSliceId(sliceId);
      // Scroll once the stream is visible again (the exit fade is 0.3s, but
      // the list beneath is live the whole time — one frame is enough).
      requestAnimationFrame(() => {
        if (sliceId === "now") {
          scrollToBottom();
          return;
        }
        const rel = sliceStartIndex(itemsRef.current, sliceId);
        if (rel !== null) {
          virtuosoRef.current?.scrollToIndex({
            index: rel,
            align: "start",
          });
        }
      });
    },
    [
      selectedSliceId,
      transition,
      resumeBlock,
      stream,
      scrollToBottom,
      resolveSliceStart,
      tHist,
    ],
  );

  // M2 jump bus: the search palette, the recall references bar and the
  // /timeline views request a stream jump through the module-level slice-jump
  // bus (or via `?at=`, below) — the handler is the same select path
  // (page-until-loaded + scroll-to-seam + the travel clock as the loading
  // state). A jump stashed while the chat page wasn't mounted replays once,
  // on registration.
  useEffect(() => {
    const unregister = registerSliceJumpHandler((sliceId) => {
      void handleSelectSlice(sliceId);
    });
    const stashed = takePendingSliceJump();
    if (stashed) void handleSelectSlice(stashed);
    return unregister;
  }, [handleSelectSlice]);

  // `?at=<sliceId>` — the timeline → chat half of the §6.1 context carry
  // (the wheel fallback's pick, the L3 traverse, a shared link). The chat
  // page stays MOUNTED under the timeline overlay, so this must react to
  // searchParam changes, not just the initial mount. Consumed once: the
  // param is stripped (replaceState, no navigation) so a refresh or a
  // re-render never re-fires the jump.
  const searchParams = useSearchParams();
  useEffect(() => {
    const at = parseAtParam(searchParams.toString());
    if (!at) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + stripAtParam(searchParams.toString()) + window.location.hash,
    );
    void handleSelectSlice(at);
  }, [searchParams, handleSelectSlice]);

  // Publish the slice at the top of the viewport — the header mode switcher
  // reads it to build `/timeline?at=…` (chat → timeline context carry).
  useEffect(() => () => setViewportSlice(null), []);
  const handleTopItemChange = useCallback(
    (iso: string, sliceId: string | null) => {
      topTimeRef.current = iso;
      setViewportSlice(sliceId);
    },
    [],
  );

  // The "PREVIOUSLY ON" eyebrow over the travel readout — same brand mark as
  // the empty briefing's title card.
  const tBrief = useTranslations("emptyBriefing");

  return (
    <>
      {/* ── Content — one centered column (v0.10 §6.1 首页瘦身): the timeline
           wheel moved to the /timeline route; no resident sidebar. The region
           below the fixed header has an explicit height; the unified stream
           (Virtuoso) owns the scroll. The stream is always mounted (§1.2
           Rev 2) — briefing mode rides its tail as a card; only an EMPTY
           memory falls back to the standalone full-screen briefing. ── */}
      <div className="pt-12">
        {/* §5.2/§6.1 Rev 6: the swipe mode switch is OFF for now (user call,
            2026-09-07 — revisit after the spine-left layout beds in); the
            header switcher / Cmd+. are the way over. ModeSwitchGesture stays
            in the tree, unwired. */}
        <div className="relative h-[calc(100vh-3rem)]">
          {emptyMemory ? (
            <div className="h-full overflow-y-auto pb-24">
              <EmptyBriefing
                persona={persona}
                active={activeSlice}
                recent={timelineSlices}
                onSend={(msg) => void handleSubmit(msg, [])}
              />
            </div>
          ) : (
            <UnifiedChatStream
              items={items}
              firstItemIndex={firstItemIndex}
              loadingOlder={stream.loadingOlder}
              onStartReached={handleStartReached}
              error={error}
              virtuosoRef={virtuosoRef}
              onTopItemChange={handleTopItemChange}
              briefing={
                showBriefingCard
                  ? {
                      persona,
                      active: activeSlice,
                      recent: timelineSlices,
                      onSend: (msg) => void handleSubmit(msg, []),
                    }
                  : null
              }
            />
          )}

          {/* ── Time-travel cover — an overlay ABOVE the stream (the list
               never unmounts, so the scroll position and the jump target
               survive the trip). Doubles as the page-loading state. ── */}
          <AnimatePresence>
            {transition && (
              <motion.div
                key="travel"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-background"
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
