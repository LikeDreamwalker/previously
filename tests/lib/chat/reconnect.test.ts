import { describe, it, expect } from "vitest";
import {
  dropTrailingAssistantMessages,
  lastStoredActivity,
} from "@/lib/chat/reconnect";
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

describe("lastStoredActivity", () => {
  const ISO = "2026-08-13T10:00:00.000Z";
  const T = new Date(ISO).getTime();

  it("returns the createdAt of the last message", () => {
    const messages = [
      msg("u1", "user"),
      { ...msg("a1", "assistant"), createdAt: ISO } as UIMessage,
    ];
    expect(lastStoredActivity(messages)).toBe(T);
  });

  it("skips messages without createdAt and uses the newest one that has it", () => {
    const messages = [
      msg("u1", "user"), // no createdAt
      { ...msg("a1", "assistant"), createdAt: T } as UIMessage,
    ];
    expect(lastStoredActivity(messages)).toBe(T);
  });

  it("accepts a numeric createdAt", () => {
    const messages = [
      { ...msg("a1", "assistant"), createdAt: T } as UIMessage,
    ];
    expect(lastStoredActivity(messages)).toBe(T);
  });

  it("accepts a Date createdAt", () => {
    const messages = [
      { ...msg("a1", "assistant"), createdAt: new Date(T) } as UIMessage,
    ];
    expect(lastStoredActivity(messages)).toBe(T);
  });

  it("returns null when no message has a usable createdAt", () => {
    expect(lastStoredActivity([msg("u1", "user"), msg("a1", "assistant")])).toBe(
      null,
    );
  });

  it("returns null for an empty list", () => {
    expect(lastStoredActivity([])).toBe(null);
  });
});
