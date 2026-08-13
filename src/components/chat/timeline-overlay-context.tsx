"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

interface TimelineOverlayValue {
  /** Whether the full-screen timeline overlay is open. */
  open: boolean;
  /** Flip it (header toggle / mini timeline tap). */
  toggle: () => void;
  /** Open it. */
  openOverlay: () => void;
  /** Close it (scrim tap / after selecting a slice). */
  close: () => void;
}

const TimelineOverlayContext = createContext<TimelineOverlayValue | null>(null);

/**
 * Shared full-screen timeline state between the header toggle button
 * (AppHeader) and the chat page, which owns the overlay + TimelineWheel. Lives
 * at the layout level so the header button can flip it without threading
 * callbacks through the server component tree. Body scroll is locked while the
 * overlay is open.
 */
export function TimelineOverlayProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const openOverlay = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <TimelineOverlayContext.Provider value={{ open, toggle, openOverlay, close }}>
      {children}
    </TimelineOverlayContext.Provider>
  );
}

export function useTimelineOverlay(): TimelineOverlayValue {
  const value = useContext(TimelineOverlayContext);
  if (!value) {
    throw new Error("useTimelineOverlay must be used within TimelineOverlayProvider");
  }
  return value;
}
