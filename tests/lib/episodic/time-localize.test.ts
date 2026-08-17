import { describe, it, expect } from "vitest";
import {
  annotateSliceWithLocalTime,
  sliceLocalBanner,
  sliceIdLocalClock,
  sliceIdRelPhrase,
} from "@/lib/episodic/time-localize";

// Slice ids/timestamps are UTC; the user is UTC+8 in these fixtures.
const TZ = "Asia/Shanghai";
// Fixed reference "now": 2026-08-17 06:00 UTC = 14:00 local — 10 days after
// the fixture slice (2026-08-07).
const NOW = "2026-08-17T06:00:00.000Z";

describe("sliceIdLocalClock", () => {
  it("converts a UTC slice id to the user's local clock", () => {
    // 2026-08-07 07:09 UTC = 15:09 in UTC+8
    expect(sliceIdLocalClock("2026/08/07/0709", TZ)).toBe("15:09");
    expect(sliceIdLocalClock("2026-08-07-0709", TZ)).toBe("15:09");
  });

  it("returns null for an unparseable id", () => {
    expect(sliceIdLocalClock("not-a-slice", TZ)).toBeNull();
  });
});

describe("sliceIdRelPhrase", () => {
  it("renders relative days in zh and en", () => {
    expect(sliceIdRelPhrase("2026/08/07/0709", TZ, { nowIso: NOW })).toBe("10 天前");
    expect(
      sliceIdRelPhrase("2026/08/07/0709", TZ, { nowIso: NOW, locale: "en" }),
    ).toBe("10 days ago");
  });

  it("returns null for an unparseable id", () => {
    expect(sliceIdRelPhrase("garbage", TZ, { nowIso: NOW })).toBeNull();
  });
});

describe("sliceLocalBanner", () => {
  it("renders the user-local date + zone + offset + relative days", () => {
    const banner = sliceLocalBanner("2026/08/07/0709", TZ, { nowIso: NOW });
    expect(banner).toContain("该时间片发生于用户当地时间");
    expect(banner).toContain("15:09");
    expect(banner).toContain("Asia/Shanghai");
    expect(banner).toContain("UTC");
    expect(banner).toContain("10 天前");
  });

  it("returns an empty string for an unparseable id", () => {
    expect(sliceLocalBanner("garbage", TZ)).toBe("");
  });
});

describe("annotateSliceWithLocalTime", () => {
  it("prepends a banner and appends 本地 clock + relative days to every turn header", () => {
    const raw = [
      "# 2026-08-07",
      "## Turn abc123 — 2026-08-07T07:09:00.000Z (user)",
      "hello",
      "## Turn abc123 — 2026-08-07T07:09:31.000Z (agent)",
      "hi",
    ].join("\n");
    const out = annotateSliceWithLocalTime(raw, TZ, "2026/08/07/0709", {
      nowIso: NOW,
    });
    expect(out).toContain("> [时间] 该时间片发生于用户当地时间");
    expect(out).toContain("下方时间戳为原始 UTC");
    expect(out).toContain("（本地 15:09 · 10 天前）");
    // Both headers annotated; original timestamps preserved.
    expect(out.match(/（本地 15:09 · 10 天前）/g)).toHaveLength(2);
    expect(out).toContain("2026-08-07T07:09:00.000Z");
  });

  it("renders the en annotation when locale is en", () => {
    const raw = "## Turn abc123 — 2026-08-07T07:09:00.000Z (user)\nhello";
    const out = annotateSliceWithLocalTime(raw, TZ, "2026/08/07/0709", {
      nowIso: NOW,
      locale: "en",
    });
    expect(out).toContain("(local 15:09 · 10 days ago)");
  });

  it("leaves content untouched when no turn headers exist", () => {
    const raw = "just some text\nno timestamps";
    const out = annotateSliceWithLocalTime(raw, TZ, "2026/08/07/0709", {
      nowIso: NOW,
    });
    expect(out).toContain("> [时间]");
    expect(out).toContain("just some text");
  });
});
