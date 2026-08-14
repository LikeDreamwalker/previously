import { describe, it, expect } from "vitest";
import {
  decideArrival,
  dropTrailingAssistantMessages,
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

// decideArrival is the pure half of the mount-time arrival verdict: the live
// view restores ONLY in-flight work (the server said the run is still
// pending/running); every other arrival opens blank so the arrival briefing
// greets the user and completed conversation stays on the timeline.
describe("decideArrival", () => {
  it("resumes with the working conversation when the run is still active", () => {
    const stored = [msg("u1", "user"), msg("a1", "assistant")];
    const d = decideArrival(true, stored);
    expect(d.shouldResume).toBe(true);
    // The trailing partial turn is dropped — the replay rebuilds it.
    expect(ids(d.initialMessages)).toEqual(["u1"]);
  });

  it("keeps a trailing user message when resuming (reply not started yet)", () => {
    const stored = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")];
    const d = decideArrival(true, stored);
    expect(d.shouldResume).toBe(true);
    expect(ids(d.initialMessages)).toEqual(["u1", "a1", "u2"]);
  });

  it("resumes into an empty store when the stash is gone (full replay)", () => {
    const d = decideArrival(true, []);
    expect(d.shouldResume).toBe(true);
    expect(d.initialMessages).toEqual([]);
  });

  it("opens blank when the run is terminal — completed conversation is NOT restored", () => {
    const stored = [msg("u1", "user"), msg("a1", "assistant")];
    const d = decideArrival(false, stored);
    expect(d.shouldResume).toBe(false);
    expect(d.initialMessages).toEqual([]);
  });

  it("opens blank when there is no stash at all", () => {
    const d = decideArrival(false, []);
    expect(d.shouldResume).toBe(false);
    expect(d.initialMessages).toEqual([]);
  });
});
