"use client";

/**
 * The header mode switcher (v0.10 §6.1) — a segmented pill「对话 · 时间线」
 * centered in the header. URL IS the mode: `/` = chat, `/timeline` = timeline,
 * so the current segment follows the route and the pill is a first-class view
 * switch (deep-linkable, refresh-safe, browser-back returns to the chat).
 *
 * Switching to the timeline carries the reading position: the slice at the
 * top of the chat stream's viewport (viewport-slice.ts) rides along as
 * `?at=<sliceId>` so the 3D camera docks at the node the user was reading.
 * Switching back to chat pushes `/` — from the intercepted overlay the push
 * leaves the modal slot mounted (Next.js keeps an unmatched parallel slot's
 * previous subpage on soft navigation), but the overlay self-hides on any
 * non-/timeline pathname (see timeline-overlay.tsx), so the chat underneath
 * is exactly as it was (it never unmounted); from the full-page form it's a
 * plain navigation home.
 *
 * `Cmd/Ctrl+.` toggles the mode (parallel to Cmd+K search). The shortcut lives
 * only on the header instance (`enableShortcut`) — the overlay renders a
 * second, shortcut-less pill so the covered header isn't the only exit.
 */
import { useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { MessageSquare, Waypoints } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { modeFromPathname, timelineHref } from "@/lib/chat/mode-switch";
import { getViewportSlice } from "@/lib/chat/viewport-slice";

export function ModeSwitcher({
  enableShortcut = true,
  /** The 3D scene is always dark — the overlay instance pins the dark tone
   *  regardless of the UI theme. */
  tone = "auto",
}: {
  enableShortcut?: boolean;
  tone?: "auto" | "dark";
}) {
  const t = useTranslations("nav.mode");
  const pathname = usePathname();
  const router = useRouter();
  const mode = modeFromPathname(pathname);

  const goChat = useCallback(() => {
    if (mode !== "chat") router.push("/");
  }, [mode, router]);

  const goTimeline = useCallback(() => {
    if (mode !== "timeline") router.push(timelineHref(getViewportSlice()));
  }, [mode, router]);

  useEffect(() => {
    if (!enableShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      e.preventDefault();
      // Read the live URL, not the `mode` render value: right after a soft
      // navigation the pathname prop can lag the address bar by a commit, and
      // a stale closure would re-push the route we're already on — the press
      // lands between the URL change and the effect re-attach and the toggle
      // appears dead (e2e: Ctrl+. right after toHaveURL).
      const inTimeline = /\/timeline\/?$/.test(window.location.pathname);
      router.push(inTimeline ? "/" : timelineHref(getViewportSlice()));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableShortcut, router]);

  const wrapTone =
    tone === "dark"
      ? "border-white/15 bg-white/5"
      : "border-border/60 bg-muted/40";
  const activeTone =
    tone === "dark"
      ? "bg-white/15 text-zinc-100 shadow-sm"
      : "bg-background text-foreground shadow-sm";
  const idleTone =
    tone === "dark"
      ? "text-zinc-400 hover:text-zinc-100"
      : "text-muted-foreground hover:text-foreground";

  const segment = (
    active: boolean,
    onClick: () => void,
    label: string,
    Icon: typeof MessageSquare,
  ) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors ${
        active ? activeTone : idleTone
      }`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{label}</span>
    </button>
  );

  return (
    <div
      role="group"
      aria-label={t("label")}
      title={`${t("label")} (⌘.)`}
      className={`flex items-center rounded-full border p-0.5 text-xs ${wrapTone}`}
    >
      {segment(mode === "chat", goChat, t("chat"), MessageSquare)}
      {segment(mode === "timeline", goTimeline, t("timeline"), Waypoints)}
    </div>
  );
}
