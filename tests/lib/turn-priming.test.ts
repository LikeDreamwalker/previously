import { describe, it, expect } from "vitest";
import {
  formatLocalTime,
  classifyContinuity,
  formatGap,
  continuityLine,
  buildSliceHeadBlock,
  CONTINUITY_WINDOW_MS,
  type PrevSliceRef,
} from "@/lib/turn-priming";

const NOW = "2026-08-02T06:32:00.000Z";

function prev(overrides: Partial<PrevSliceRef> = {}): PrevSliceRef {
  return {
    id: "2026-08-02-0530",
    focus: "Rust loop tests",
    start: "2026-08-02T05:00:00.000Z",
    end: "2026-08-02T05:30:00.000Z",
    ...overrides,
  };
}

// ─── formatLocalTime ──────────────────────────────────────────────────────

describe("formatLocalTime", () => {
  it("formats local time + UTC offset in the client's timezone", () => {
    const t = formatLocalTime(NOW, "Asia/Shanghai");
    expect(t.local).toBe("02 Aug 2026, 14:32"); // 06:32 UTC + 8h
    expect(t.zone).toBe("Asia/Shanghai");
    expect(t.offset).toMatch(/^UTC/); // "UTC+8" (Node full-icu) — allow any UTC offset string
    expect(t.utc).toBe("2026-08-02T06:32:00.000Z");
  });

  it("falls back to UTC for an invalid timezone instead of throwing", () => {
    const t = formatLocalTime(NOW, "Not/AZone");
    expect(t.zone).toBe("UTC");
    expect(t.local).toBe(t.utc);
  });

  it("treats an empty timezone as UTC", () => {
    const t = formatLocalTime(NOW, "");
    expect(t.zone).toBe("UTC");
  });
});

// ─── classifyContinuity ───────────────────────────────────────────────────

describe("classifyContinuity", () => {
  it("marks a continued active slice as continuing regardless of prevSlice", () => {
    const c = classifyContinuity(NOW, prev(), true);
    expect(c.tier).toBe("continuing");
  });

  it("classifies a close within the window as a recent return", () => {
    const c = classifyContinuity(NOW, prev(), false);
    expect(c.tier).toBe("recent_return");
    expect(c.gapMs).toBe(3_720_000); // end 05:30 → now 06:32 (1h02m)
  });

  it("classifies a close beyond the window as cold", () => {
    const c = classifyContinuity(NOW, prev({ start: "2026-07-20T00:00:00.000Z", end: "2026-07-20T01:00:00.000Z" }), false);
    expect(c.tier).toBe("cold");
    expect(c.gapMs).toBeGreaterThanOrEqual(CONTINUITY_WINDOW_MS);
  });

  it("returns none when there is no previous slice", () => {
    const c = classifyContinuity(NOW, null, false);
    expect(c.tier).toBe("none");
  });

  it("falls back to `start` when the previous slice has no end", () => {
    const c = classifyContinuity(NOW, prev({ end: undefined }), false);
    expect(c.gapMs).toBe(5_520_000); // start 05:00 → now 06:32
    expect(c.tier).toBe("recent_return");
  });
});

// ─── formatGap ────────────────────────────────────────────────────────────

describe("formatGap", () => {
  it("formats minutes", () => expect(formatGap(5 * 60_000)).toBe("5 mins ago"));
  it("formats hours", () => expect(formatGap(90 * 60_000)).toBe("2 hours ago"));
  it("formats days", () => expect(formatGap(2 * 86_400_000)).toBe("2 days ago"));
});

// ─── continuityLine ───────────────────────────────────────────────────────

describe("continuityLine", () => {
  it("frames a recent return with the previous slice's focus and a recall-first hint", () => {
    const line = continuityLine({
      tier: "recent_return",
      gapMs: 3_600_000,
      prevSlice: prev(),
    });
    expect(line).toContain(
      'The user\'s last session ended 1 hour ago (slice 2026-08-02-0530, "Rust loop tests")',
    );
    expect(line).toContain("Recall that slice FIRST");
  });

  it("frames a cold start as start-fresh", () => {
    const line = continuityLine({
      tier: "cold",
      gapMs: 5 * 86_400_000,
      prevSlice: prev(),
    });
    expect(line).toContain("The user's last session was 5 days ago");
    expect(line).toContain("start fresh");
  });

  it("frames first contact", () => {
    expect(continuityLine({ tier: "none" })).toBe("No past conversation yet.");
  });
});

// ─── buildSliceHeadBlock (L3 — frozen slice-head snapshot) ────────────────
// NOW = 2026-08-02 06:32 UTC = 14:32 in Asia/Shanghai — a Sunday.

describe("buildSliceHeadBlock", () => {
  function makeInput(overrides: Partial<Parameters<typeof buildSliceHeadBlock>[0]> = {}) {
    return {
      sliceStartIso: NOW,
      clientTimezone: "Asia/Shanghai",
      continuity: { tier: "recent_return", gapMs: 3_720_000, prevSlice: prev() } as const,
      ...overrides,
    };
  }

  it("opens with the slice-start local time, zone and UTC instant", () => {
    const block = buildSliceHeadBlock(makeInput());
    expect(block).toContain("## This slice — snapshot at its start");
    expect(block).toContain("- Slice started: 02 Aug 2026, 14:32 (Asia/Shanghai");
    expect(block).toContain("UTC 2026-08-02T06:32:00.000Z");
  });

  it("injects the precomputed date-anchor table (en by default)", () => {
    const block = buildSliceHeadBlock(makeInput());
    expect(block).toContain("Date anchors");
    expect(block).toContain("Today: 2026-08-02 (Sun)");
    expect(block).toContain("This week's Monday: 2026-07-27");
    expect(block).toContain("Last week: 2026-07-20 (Mon) → 2026-07-26 (Sun)");
    expect(block).toContain("Tomorrow: 2026-08-03 (Mon)");
  });

  it("renders the anchor table in zh when locale is zh", () => {
    const block = buildSliceHeadBlock(makeInput({ locale: "zh" }));
    expect(block).toContain("日期锚点");
    expect(block).toContain("今天：2026-08-02（周日）");
    expect(block).toContain("上周：2026-07-20（周一） 至 2026-07-26（周日）");
  });

  it("includes the frozen continuity line", () => {
    const block = buildSliceHeadBlock(makeInput());
    expect(block).toContain("- Continuity: The user's last session ended");
    expect(block).toContain("2026-08-02-0530");
  });

  it("includes the birth-evolution summary only when provided", () => {
    const withSummary = buildSliceHeadBlock(
      makeInput({ evolutionSummary: "sharpened the profile around work stress" }),
    );
    expect(withSummary).toContain(
      "- The user card was updated just as this slice began: sharpened the profile around work stress",
    );
    expect(buildSliceHeadBlock(makeInput())).not.toContain("user card was updated");
  });

  it("carries the drift hint pointing at the currentTime tool, and the local-time guidance", () => {
    const block = buildSliceHeadBlock(makeInput());
    expect(block).toContain("currentTime");
    expect(block).toContain("tens of minutes old");
    expect(block).toContain("Use the user's local time (Asia/Shanghai)");
  });

  it("is byte-identical for two turns of the same slice (freeze contract)", () => {
    // Deterministic in its inputs: housekeeping recomputes the same inputs
    // (anchored to slice.start) on every turn, so the block never drifts
    // mid-slice.
    expect(buildSliceHeadBlock(makeInput())).toBe(buildSliceHeadBlock(makeInput()));
  });
});
