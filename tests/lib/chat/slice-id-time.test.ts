import { describe, it, expect } from "vitest";
import { sliceIdToIso, formatSliceIdLabel } from "@/lib/chat/slice-id-time";

describe("sliceIdToIso", () => {
  it("decodes the UTC instant a slice id encodes", () => {
    expect(sliceIdToIso("2026-08-01-1000")).toBe("2026-08-01T10:00:00.000Z");
  });

  it("rejects malformed ids", () => {
    expect(sliceIdToIso("not-a-slice")).toBeNull();
    expect(sliceIdToIso("2026-08-01")).toBeNull();
  });
});

describe("formatSliceIdLabel", () => {
  // Fixed UTC zone keeps the test host-independent.
  it("renders a short locale label from the id's instant", () => {
    const label = formatSliceIdLabel("2026-02-10-1430", "en", "UTC");
    expect(label).toContain("14:30");
    expect(label).toContain("02");
    expect(label).toContain("10");
  });

  it("formats Chinese locale without 12-hour clock", () => {
    const label = formatSliceIdLabel("2026-02-10-1430", "zh", "UTC");
    expect(label).toContain("14:30");
  });

  it("returns empty string for a malformed id", () => {
    expect(formatSliceIdLabel("bogus", "en", "UTC")).toBe("");
  });
});
