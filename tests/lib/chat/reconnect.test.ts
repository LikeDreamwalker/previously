import { describe, it, expect } from "vitest";
import { dropTrailingAssistantMessages } from "@/lib/chat/reconnect";
import type { UIMessage } from "ai";

// dropTrailingAssistantMessages is the pure half of the reconnect reset: it
// removes the partial in-flight assistant reply so a startIndex-0 replay
// rebuilds the turn cleanly instead of appending a second copy (which would
// duplicate message ids and can loop React into "Maximum update depth
// exceeded" #185).

function msg(id: string, role: UIMessage["role"]): UIMessage {
  return { id, role, parts: [] } as UIMessage;
}

const ids = (msgs: UIMessage[]) => msgs.map((m) => m.id);

describe("dropTrailingAssistantMessages", () => {
  it("drops a single trailing partial assistant message", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant")];
    expect(ids(dropTrailingAssistantMessages(messages))).toEqual(["u1"]);
  });

  it("drops all trailing assistant messages (double-writer leftovers)", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("a2", "assistant"),
    ];
    expect(ids(dropTrailingAssistantMessages(messages))).toEqual(["u1"]);
  });

  it("keeps prior completed turns intact", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
    ];
    expect(ids(dropTrailingAssistantMessages(messages))).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  it("leaves a trailing user message untouched (fresh turn in flight)", () => {
    const messages = [msg("u1", "user"), msg("u2", "user")];
    expect(ids(dropTrailingAssistantMessages(messages))).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("does not mutate the input array", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant")];
    const before = ids(messages);
    dropTrailingAssistantMessages(messages);
    expect(ids(messages)).toEqual(before);
  });

  it("returns a fresh empty array for an empty input", () => {
    const out = dropTrailingAssistantMessages([]);
    expect(out).toEqual([]);
    expect(out).not.toBe([]);
  });
});
