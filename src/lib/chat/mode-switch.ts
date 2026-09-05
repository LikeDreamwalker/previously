/**
 * Pure helpers for the chat ⇄ timeline mode switch (v0.10 §6.1: "URL 即模式").
 *
 * - `/` is chat mode, `/timeline` is timeline mode. The pathname seen here is
 *   the locale-stripped one (next-intl's `usePathname`).
 * - `?at=<sliceId>` carries the reading position across the boundary both
 *   ways: chat → timeline docks the 3D camera at that node, timeline → chat
 *   pages the slice into the stream and scroll-lands on its seam.
 */

export type ViewMode = "chat" | "timeline";

/** The mode a locale-stripped pathname belongs to. */
export function modeFromPathname(pathname: string): ViewMode {
  return pathname === "/timeline" || pathname.startsWith("/timeline/")
    ? "timeline"
    : "chat";
}

/**
 * Extract a valid `at` anchor from a query string (with or without the
 * leading `?`). Blank values and the sentinel "now" are no anchor at all —
 * "now" is the timeline's default camera position.
 */
export function parseAtParam(search: string): string | null {
  const at = new URLSearchParams(search).get("at")?.trim();
  return at && at !== "now" ? at : null;
}

/**
 * Remove the `at` param from a query string, returning the remaining query
 * (with leading `?`) or an empty string — the chat page consumes the anchor
 * once, then strips it so a refresh doesn't re-jump.
 */
export function stripAtParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("at");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The timeline href carrying an optional reading-position anchor. */
export function timelineHref(at: string | null): string {
  return at ? `/timeline?at=${encodeURIComponent(at)}` : "/timeline";
}
