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

export interface ArrivalDecision {
  /** Passed to useChat's `resume` — re-attach to the in-flight run's stream. */
  shouldResume: boolean;
  /** Passed to useChat's `messages` — the conversation the live view opens with. */
  initialMessages: UIMessage[];
}

/**
 * The mount-time arrival decision — the pure half (side effects like reading /
 * clearing localStorage live in the caller).
 *
 * The rule is one-dimensional: the live view restores ONLY in-flight work.
 * `runActive` is the server's verdict on the persisted run ("pending" /
 * "running" — see isChatRunActive); the client never infers slice boundaries
 * from timestamps or silence windows.
 *
 * - Run still active → genuine reconnect: keep the working conversation, but
 *   drop the trailing partial assistant turn (the replay rebuilds it).
 * - Anything else (no run, or a terminal one) → fresh arrival: open blank so
 *   the arrival briefing greets the user. Completed conversation is NOT
 *   restored into the live view — it belongs to its slice on the timeline.
 */
export function decideArrival(
  runActive: boolean,
  stored: readonly UIMessage[],
): ArrivalDecision {
  if (runActive) {
    return {
      shouldResume: true,
      initialMessages: dropTrailingAssistantMessages(stored),
    };
  }
  return { shouldResume: false, initialMessages: [] };
}
