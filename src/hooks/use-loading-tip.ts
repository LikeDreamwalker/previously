"use client";

import { useMessages } from "next-intl";
import { useRef } from "react";

interface ChatMessages {
  chat?: {
    loadingTips?: string[];
  };
}

/** Returns all loading tips from the current locale. */
export function useLoadingTips(): string[] {
  const allMessages = useMessages() as ChatMessages;
  return allMessages.chat?.loadingTips ?? [];
}

/** Returns one random tip, stable for the component lifetime. */
export function useRandomLoadingTip(): string {
  const tips = useLoadingTips();
  const tipRef = useRef<string | null>(null);
  if (tipRef.current === null && tips.length > 0) {
    tipRef.current = tips[Math.floor(Math.random() * tips.length)];
  }
  return tipRef.current ?? "";
}
