"use client";

import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import { ToolLayout } from "./tool-layout";
import { MarkdownRenderer } from "./markdown";

interface ThinkingBlockProps {
  text: string;
  isStreaming?: boolean;
  /** Server-measured reasoning duration (ms) — preferred over the local timer,
      which is lost when the finished message re-renders from scratch. */
  durationMs?: number;
}

const COMPLETED_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const STREAMING_STATE: ToolRenderState = {
  running: true,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

export function ThinkingSteps({ text, isStreaming = false, durationMs }: ThinkingBlockProps) {
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      if (startTimeRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }

    if (startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }

    intervalRef.current = setInterval(() => {
      setElapsed(
        Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000),
      );
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isStreaming]);

  const hasContent = text.trim().length > 0;
  const seconds =
    durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : elapsed;
  const name = isStreaming
    ? "正在思考…"
    : seconds > 0
      ? `思考完成 · ${seconds}s`
      : "思考完成";
  const summary = "";

  const expandedContent = hasContent ? (
    <MarkdownRenderer content={text} />
  ) : undefined;

  return (
    <ToolLayout
      name={name}
      icon={<Brain className="h-3.5 w-3.5" />}
      summary={summary}
      state={isStreaming ? STREAMING_STATE : COMPLETED_STATE}
      expandedContent={expandedContent}
    />
  );
}
