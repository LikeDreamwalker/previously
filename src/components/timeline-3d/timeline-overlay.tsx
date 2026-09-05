"use client";

/**
 * Fullscreen timeline overlay — the intercepted-route (modal) form of
 * /timeline. Visually FULLSCREEN (no popover margins/backdrop): it covers the
 * chat page beneath (which never unmounts, per doc/design/v0.10.0-memory-viz.md
 * §6.1) and closes via Escape or the in-overlay mode switcher (the overlay
 * covers the header, so the chat exit is duplicated inside). The background
 * follows the app theme (`bg-background`), not a fixed black.
 *
 * Closing semantics: Next.js keeps an unmatched parallel slot's previous
 * active subpage on SOFT navigation, so a `router.push("/")` (the mode
 * switcher's Chat segment, the header's ⌘. shortcut, the scene's L3 traverse
 * to `/?at=`) leaves this slot mounted. The overlay therefore also self-hides
 * whenever the pathname leaves /timeline — Escape still uses `router.back()`
 * so the history entry is popped properly.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePathname } from "@/i18n/navigation";
import { modeFromPathname } from "@/lib/chat/mode-switch";
import { ModeSwitcher } from "@/components/layout/mode-switcher";

export function TimelineOverlay({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  // Self-hide once the URL leaves timeline mode (see the module comment) —
  // the chat page beneath is live and consumes any `?at=` anchor itself.
  if (modeFromPathname(pathname) !== "timeline") return null;

  return (
    <div className="fixed inset-0 z-50 bg-background">
      {children}
      {/* The overlay covers the header (same z-50, later in DOM) — the chat
          exit must live inside: a mode switcher floating over the scene.
          Shortcut-less: the header instance owns Cmd/Ctrl+. */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
        <div className="pointer-events-auto">
          <ModeSwitcher enableShortcut={false} />
        </div>
      </div>
    </div>
  );
}
