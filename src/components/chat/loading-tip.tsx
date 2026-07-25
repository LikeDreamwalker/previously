"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useTranslations } from "next-intl";
import { useLoadingTips } from "@/hooks/use-loading-tip";

const INTERVAL_MS = 4000;

/** Sentinel value marking a generic "Loading…" slot in the display sequence. */
const LOADING_SLOT = "__loading__";

/**
 * Build a display sequence that interleaves tips with a generic
 * loading placeholder every 3rd position (after every 2 tips):
 *   tip₀  →  tip₁  →  Loading…  →  tip₂  →  tip₃  →  Loading…  →  …
 */
function buildDisplaySequence(tips: string[]): string[] {
  const seq: string[] = [];
  for (let i = 0; i < tips.length; i++) {
    seq.push(tips[i]);
    // Insert a loading slot after every 2nd tip (except at the very end)
    if ((i + 1) % 2 === 0 && i < tips.length - 1) {
      seq.push(LOADING_SLOT);
    }
  }
  return seq;
}

/**
 * Animated loading indicator for the assistant bubble.
 *
 * Shows a spinner + a cycling sequence that rotates through product tips
 * interspersed with a generic "Loading…" placeholder (every 3rd slot).
 * Transitions use a subtle vertical-crossfade via AnimatePresence.
 *
 * The starting position is random so repeat requests don't always
 * begin at the same tip.
 */
export function LoadingTip() {
  const tips = useLoadingTips();
  const t = useTranslations("common");

  const sequence = useMemo(() => buildDisplaySequence(tips), [tips]);

  const [index, setIndex] = useState(() =>
    sequence.length > 0 ? Math.floor(Math.random() * sequence.length) : 0,
  );
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (sequence.length <= 1) return;
    timerRef.current = setInterval(() => {
      setIndex((prev) => (prev + 1) % sequence.length);
    }, INTERVAL_MS);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [sequence.length]);

  const item = sequence[index];
  if (item === undefined) return null;

  const isGeneric = item === LOADING_SLOT;
  const displayText = isGeneric ? t("loading") : item;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
      <span className="relative inline-block overflow-hidden">
        <AnimatePresence mode="popLayout">
          <motion.span
            key={isGeneric ? `loading-${index}` : index}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="block"
          >
            {displayText}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}
