"use client";

import { useEffect } from "react";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

/**
 * Registers window-level error listeners so EVERY client-side error is logged
 * with full detail — not the minified production message. Some errors never
 * reach React's onError: the AI SDK's WorkflowChatTransport catches stream
 * failures and swallows them (console.error only, no rethrow), and unhandled
 * promise rejections bypass React entirely. These listeners catch both and
 * print the complete error via formatErrorDetail. Renders null.
 */
export function ClientErrorCapture(): null {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      console.error(
        `[ClientError][window.onerror] ${formatErrorDetail(event.error ?? event.message)}`,
      );
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      console.error(
        `[ClientError][unhandledrejection] ${formatErrorDetail(event.reason)}`,
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
