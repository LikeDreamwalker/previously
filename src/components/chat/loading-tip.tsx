"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useLoadingTips } from "@/hooks/use-loading-tip";

const ROTATE_INTERVAL_MS = 4_000;

/**
 * Loading indicator that cycles through tips from the locale's
 * `chat.loadingTips` array. Picks a random starting tip so concurrent
 * bubbles don't all show the same text, then rotates to a different
 * tip every {@link ROTATE_INTERVAL_MS} ms with a fade transition.
 */
export function LoadingTip() {
  const t = useTranslations("chat.phase");
  const tips = useLoadingTips();

  const pickRandom = useCallback(
    (excludeIndex: number) => {
      if (tips.length <= 1) return 0;
      let next = Math.floor(Math.random() * tips.length);
      while (next === excludeIndex && tips.length > 1) {
        next = Math.floor(Math.random() * tips.length);
      }
      return next;
    },
    [tips.length],
  );

  const [index, setIndex] = useState(() =>
    tips.length > 0 ? Math.floor(Math.random() * tips.length) : 0,
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (tips.length <= 1) return;

    const timer = setInterval(() => {
      if (!mountedRef.current) return;
      setIndex((prev) => pickRandom(prev));
    }, ROTATE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [tips.length, pickRandom]);

  // Fallback to static "Thinking…" when no tips array is available
  const text = tips.length > 0 ? tips[index] : t("thinking");

  return (
    <span
      key={index}
      className="animate-slide-up-fade text-xs text-muted-foreground"
    >
      {text}
    </span>
  );
}
