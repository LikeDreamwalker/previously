import { describe, it, expect } from "vitest";
import { splitHighlight } from "@/lib/chat/highlight";

describe("splitHighlight", () => {
  it("splits around every case-insensitive occurrence", () => {
    expect(splitHighlight("Memory and memory Viz", "memory")).toEqual([
      { text: "Memory", match: true },
      { text: " and ", match: false },
      { text: "memory", match: true },
      { text: " Viz", match: false },
    ]);
  });

  it("passes the text through for an empty needle", () => {
    expect(splitHighlight("anything", "  ")).toEqual([
      { text: "anything", match: false },
    ]);
  });

  it("handles matches at the edges", () => {
    expect(splitHighlight("abXab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: "X", match: false },
      { text: "ab", match: true },
    ]);
  });

  it("returns one plain segment when nothing matches", () => {
    expect(splitHighlight("hello", "zzz")).toEqual([
      { text: "hello", match: false },
    ]);
  });
});
