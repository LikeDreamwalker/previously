"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import { useMemo, useState, useRef, useCallback } from "react";
import type { UIMessage } from "ai";
import { ChatInput } from "./chat-input";
import { ChatSection } from "./chat-section";
import { LoopWatcher } from "./loop-watcher";
import { LoadedIdsProvider, useLoadedIds } from "./loaded-ids-context";
import { buildMockSteps } from "@/lib/chat/mock-stream";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

function getClientSetting(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

/**
 * localStorage key holding the run id of a turn still streaming when the tab
 * was last closed. Written on send (from the x-workflow-run-id header), cleared
 * when the stream finishes; its presence at mount drives same-browser resume.
 */
const ACTIVE_RUN_KEY = "PREVIOUSLY_ACTIVE_RUN_ID";

interface ChatPageProps {
  children: React.ReactNode;
}

/**
 * Thin client shell: nothing but the LoadedIdsProvider. The real work
 * happens in `Inner` which lives inside the provider so it can access
 * the loaded-ids context.
 */
export function ChatPage({ children }: ChatPageProps) {
  return (
    <LoadedIdsProvider>
      <Inner>{children}</Inner>
    </LoadedIdsProvider>
  );
}

function Inner({ children }: { children: React.ReactNode }) {
  const [settings] = useState(() => ({
    model: getClientSetting("PREVIOUSLY_MODEL", "deepseek-v4-flash"),
    thinking: getClientSetting("PREVIOUSLY_THINKING", "true") !== "false",
  }));

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);
  const { snapshot } = useLoadedIds();

  // ── Mock demo state ─────────────────────────────────────────────────
  const [demoMessages, setDemoMessages] = useState<UIMessage[]>([]);
  const [demoStreaming, setDemoStreaming] = useState(false);
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runDemo = useCallback(() => {
    // Clear any running demo
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

  // FIXME(#localStorage-resume): disabled — stale run ids from previous
  // mounts were causing the chat to get stuck in streaming state (red stop
  // button). Re-enable once the resume path is cleaned up.
  // const initialActiveRunId = useMemo<string | undefined>(() => {
  //   if (typeof window === "undefined") return undefined;
  //   return localStorage.getItem(ACTIVE_RUN_KEY) ?? undefined;
  // }, []);

  const { messages, sendMessage, status, stop, error } = useChat({
    resume: false, // was: !!initialActiveRunId
    // Every turn runs inside a durable Workflow run. WorkflowChatTransport reads
    // the x-workflow-run-id header, auto-reconnects on same-session drops, and
    // resumes post-reload via /api/chat/{runId}/stream. Created inline (like the
    // old DefaultChatTransport) so prepareSendMessagesRequest closes over the
    // current settings/loaded-ids at send time.
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
          loadedSliceIds: snapshot(),
        },
      }),
      // FIXME(#localStorage-resume): localStorage writes disabled — see above.
      onChatSendMessage: (_response) => {},
      onChatEnd: () => {},
      prepareReconnectToStreamRequest: (config) => config,
    }),
  });

  const isStreaming = status === "streaming" || demoStreaming;
  const isLoading = status === "submitted" || isStreaming;

  // Merge real + demo messages for rendering
  const allMessages = useMemo(() => {
    if (demoMessages.length > 0) return demoMessages;
    return messages;
  }, [messages, demoMessages]);

  const handleSubmit = (message: string) => {
    setLastUserMessageAt(new Date().toISOString());
    sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
  };

  return (
    <div className="relative h-screen w-full bg-background">
      <MessageScrollerProvider defaultScrollPosition="start">
        <MessageScroller className="size-full">
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={isStreaming}
              className="mx-auto max-w-5xl xl:max-w-7xl px-4 sm:px-6 lg:px-8 pb-28"
            >
              {/* RSC slots: hero + timeline, rendered server-side */}
              {children}

              {/* Client: AI SDK chat messages */}
              <ChatSection
                messages={allMessages}
                isStreaming={isStreaming}
                isLoading={isLoading}
                error={error}
                lastUserMessageAt={lastUserMessageAt}
              />

              {/* Side-effects: subscribes to loop streams, toasts on completion */}
              <LoopWatcher messages={messages} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton className="!bottom-28" />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="fixed bottom-0 inset-x-0 z-10 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
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
  );
}
