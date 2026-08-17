import { describe, it, expect } from "vitest";
import { detectNoProgressFromReports } from "@/lib/loops/guards";
import type { LoopReportLike } from "@/lib/loops/guards";

describe("detectNoProgressFromReports", () => {
  it("returns false when fewer than 3 reports", () => {
    const reports: LoopReportLike[] = [
      { action: "search", result: "found something" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(false);
  });

  it("returns false when exactly 2 reports", () => {
    const reports: LoopReportLike[] = [
      { action: "search", result: "found something" },
      { action: "search", result: "found something" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(false);
  });

  it("returns true when 3 reports are byte-identical", () => {
    const reports: LoopReportLike[] = [
      { action: "read file", result: "no issues found" },
      { action: "read file", result: "no issues found" },
      { action: "read file", result: "no issues found" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(true);
  });

  it("returns true when 3 reports differ only in punctuation", () => {
    // Punctuation is stripped by normalizeReport, so these normalize to
    // the same word set → Jaccard 1.0.
    const reports: LoopReportLike[] = [
      { action: "read file", result: "found issue." },
      { action: "read file", result: "found issue!" },
      { action: "read file", result: "found issue" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(true);
  });

  it("returns true when 3 reports differ only in case", () => {
    const reports: LoopReportLike[] = [
      { action: "Read File", result: "FOUND ISSUE" },
      { action: "read file", result: "found issue" },
      { action: "READ FILE", result: "Found Issue" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(true);
  });

  it("returns true when 3 reports are near-duplicates (one word swapped)", () => {
    // These share 13 words, differ by 1 ("information" vs "data").
    // Jaccard ≈ 0.87 → above the 0.85 threshold.
    const reports: LoopReportLike[] = [
      {
        action: "read the memory file for user context and settings",
        result: "found relevant information about the preferences",
      },
      {
        action: "read the memory file for user context and settings",
        result: "found relevant data about the preferences",
      },
      {
        action: "read the memory file for user context and settings",
        result: "found relevant information about the preferences",
      },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(true);
  });

  it("returns false when 3 reports are clearly different", () => {
    const reports: LoopReportLike[] = [
      { action: "search the web", result: "found three articles" },
      { action: "write memory file", result: "saved user preferences" },
      { action: "read timeline slice", result: "recalled past conversation" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(false);
  });

  it("returns false when 2 reports are similar but the 3rd is different", () => {
    // The first two are near-identical; the third is unrelated.
    const reports: LoopReportLike[] = [
      {
        action: "read the memory file for user context and settings",
        result: "found relevant information about the preferences",
      },
      {
        action: "read the memory file for user context and settings",
        result: "found relevant data about the preferences",
      },
      {
        action: "deploy to production",
        result: "all systems operational and healthy",
      },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(false);
  });

  it("returns true when all 3 reports are empty strings", () => {
    // Two empty normalized sets → Jaccard = 1 (by design).
    const reports: LoopReportLike[] = [
      { action: "", result: "" },
      { action: "", result: "" },
      { action: "", result: "" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(true);
  });

  it("handles more than 3 reports by checking only the last 3", () => {
    const reports: LoopReportLike[] = [
      { action: "alpha", result: "first report" },
      { action: "beta", result: "second report" },
      { action: "gamma", result: "third identical" },
      { action: "gamma", result: "third identical" },
      { action: "gamma", result: "third identical" },
    ];
    expect(detectNoProgressFromReports(reports)).toBe(true);
  });
});

// ─── Wall-clock deadline guard (B4) ──────────────────────────────────────────

describe("detectPastDeadline / stepFinishedAtMs", () => {
  const DEADLINE = Date.parse("2026-08-16T12:00:00.000Z");

  function stepAt(iso: string) {
    return { response: { timestamp: new Date(iso) } };
  }

  it("false when there are no steps", async () => {
    const { detectPastDeadline } = await import("@/lib/loops/guards");
    expect(detectPastDeadline([], DEADLINE)).toBe(false);
  });

  it("false when the latest step finished before the deadline", async () => {
    const { detectPastDeadline } = await import("@/lib/loops/guards");
    const steps = [stepAt("2026-08-16T10:00:00.000Z"), stepAt("2026-08-16T11:59:59.000Z")];
    expect(detectPastDeadline(steps, DEADLINE)).toBe(false);
  });

  it("true when the latest step finished at/after the deadline", async () => {
    const { detectPastDeadline } = await import("@/lib/loops/guards");
    expect(detectPastDeadline([stepAt("2026-08-16T12:00:00.000Z")], DEADLINE)).toBe(true);
    expect(detectPastDeadline([stepAt("2026-08-16T13:30:00.000Z")], DEADLINE)).toBe(true);
  });

  it("accepts string/number timestamps (post-serialization shapes)", async () => {
    const { detectPastDeadline } = await import("@/lib/loops/guards");
    expect(
      detectPastDeadline([{ response: { timestamp: "2026-08-16T12:00:01.000Z" } }], DEADLINE),
    ).toBe(true);
    expect(
      detectPastDeadline([{ response: { timestamp: DEADLINE + 1000 } }], DEADLINE),
    ).toBe(true);
  });

  it("ignores steps without a usable timestamp", async () => {
    const { detectPastDeadline, stepFinishedAtMs } = await import("@/lib/loops/guards");
    expect(detectPastDeadline([{ response: {} }], DEADLINE)).toBe(false);
    expect(stepFinishedAtMs({})).toBeNull();
    expect(stepFinishedAtMs({ response: { timestamp: "not a date" } })).toBeNull();
  });
});
