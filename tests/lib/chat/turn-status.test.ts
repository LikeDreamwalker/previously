import { describe, it, expect } from "vitest";
import {
  deriveTurnStatus,
  type TurnOutcome,
} from "@/lib/chat/turn-types";

function outcome(partial: Partial<TurnOutcome>): TurnOutcome {
  return {
    text: "",
    finishReason: "stop",
    startedLoops: [],
    cognition: "",
    ...partial,
  };
}

describe("deriveTurnStatus", () => {
  it("maps finishReason stop to done", () => {
    expect(deriveTurnStatus(outcome({ finishReason: "stop", text: "hi" }))).toBe(
      "done",
    );
  });

  it("maps a non-stop finish with partial text to interrupted", () => {
    expect(
      deriveTurnStatus(outcome({ finishReason: "length", text: "partial…" })),
    ).toBe("interrupted");
  });

  it("maps a non-stop finish with no text to error", () => {
    expect(deriveTurnStatus(outcome({ finishReason: "error", text: "" }))).toBe(
      "error",
    );
  });
});
