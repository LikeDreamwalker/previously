import type { UIMessage } from "ai";

/**
 * Drop the trailing partial assistant message(s) — the in-flight reply of the
 * turn being reconnected.
 *
 * The reconnect stream replays from index 0 and rebuilds the whole turn, so if
 * the client still holds the partial assistant message (same-session reconnect,
 * no reload), a resume would append a second copy of it: two messages rendering
 * the same content, and — under a concurrent second stream — the same message
 * id alternating in the list. Both paths feed React's duplicate-key
 * reconciliation, which can loop into "Maximum update depth exceeded" (#185).
 *
 * Prior turns (user/assistant pairs before the current user message) are left
 * intact; the replay then rebuilds the resumed turn cleanly. If the list does
 * not end with an assistant message (fresh page, or a new turn is still in
 * flight), this is a no-op.
 */
export function dropTrailingAssistantMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "assistant") end--;
  return messages.slice(0, end);
}

/**
 * The timestamp (ms) of the newest message in a persisted conversation, or null
 * when no message carries a usable createdAt.
 *
 * Drives the "am I still in the same time slice?" decision on refresh: a
 * conversation whose newest message is older than the time-silence window has
 * been closed as a slice, so the live view should open blank (arrival briefing)
 * instead of restoring the stale conversation.
 */
export function lastStoredActivity(messages: readonly UIMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    // createdAt isn't on the UIMessage type (useChat attaches it at runtime,
    // and JSON round-tripping turns the Date into an ISO string), so access it
    // structurally.
    const t = (messages[i] as { createdAt?: unknown }).createdAt;
    if (!t) continue;
    const ms =
      typeof t === "number"
        ? t
        : typeof t === "string"
          ? Date.parse(t)
          : t instanceof Date
            ? t.getTime()
            : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}
