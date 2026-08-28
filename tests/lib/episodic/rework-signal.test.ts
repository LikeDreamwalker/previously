/**
 * Tests for the rework-signal classification (src/lib/episodic/rework-signal.ts)
 * — the pure per-conversation record: recordRecallOutcome + checkReadSlice.
 * No I/O is exercised here (logReworkSignal's writes are covered implicitly by
 * the store tests); each test uses a unique conversation id because the record
 * is module-level state.
 */
import { describe, it, expect } from "vitest";
import {
  recordRecallOutcome,
  checkReadSlice,
} from "@/lib/episodic/rework-signal";

const OUTCOME = {
  referenceIds: ["2026-08-20-1430", "2026-08-21-0900"],
  searchedIds: [
    "timeline window 2026-08-01 → 2026-08-21",
    "slice 2026-08-19-2000 (summary only)",
  ],
  confidence: 0.8,
};

describe("checkReadSlice", () => {
  it("returns null when no recall has run in the conversation", () => {
    expect(checkReadSlice("conv-none", "2026-08-20-1430")).toBeNull();
  });

  it("classifies a read of a referenced slice as verify", () => {
    recordRecallOutcome("conv-verify", OUTCOME);
    expect(checkReadSlice("conv-verify", "2026-08-20-1430")).toBe("verify");
  });

  it("classifies a read within recall's searched trail as verify", () => {
    recordRecallOutcome("conv-searched", OUTCOME);
    // 2026-08-19-2000 was searched (summary only) but not cited.
    expect(checkReadSlice("conv-searched", "2026-08-19-2000")).toBe("verify");
  });

  it("classifies a read outside references AND searched as rework", () => {
    recordRecallOutcome("conv-rework", OUTCOME);
    expect(checkReadSlice("conv-rework", "2026-07-01-0800")).toBe("rework");
  });

  it("returns null when the read target IS the ongoing conversation slice", () => {
    recordRecallOutcome("conv-self", OUTCOME);
    expect(checkReadSlice("conv-self", "conv-self")).toBeNull();
  });

  it("the latest recall in a conversation supersedes the earlier one", () => {
    recordRecallOutcome("conv-latest", OUTCOME);
    recordRecallOutcome("conv-latest", {
      referenceIds: ["2026-08-22-1000"],
      searchedIds: [],
      confidence: 0.5,
    });
    expect(checkReadSlice("conv-latest", "2026-08-20-1430")).toBe("rework");
    expect(checkReadSlice("conv-latest", "2026-08-22-1000")).toBe("verify");
  });
});
