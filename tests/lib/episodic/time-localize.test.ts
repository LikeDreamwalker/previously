import { describe, it, expect } from "vitest";
import {
  annotateSliceWithLocalTime,
  sliceLocalBanner,
  sliceIdLocalClock,
} from "@/lib/episodic/time-localize";

// Slice ids/timestamps are UTC; the user is UTC+8 in these fixtures.
const TZ = "Asia/Shanghai";

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

describe("sliceLocalBanner", () => {
  it("renders the user-local date + zone + offset", () => {
    const banner = sliceLocalBanner("2026/08/07/0709", TZ);
    expect(banner).toContain("该时间片发生于用户当地时间");
    expect(banner).toContain("15:09");
    expect(banner).toContain("Asia/Shanghai");
    expect(banner).toContain("UTC");
  });

  it("returns an empty string for an unparseable id", () => {
    expect(sliceLocalBanner("garbage", TZ)).toBe("");
  });
});

describe("annotateSliceWithLocalTime", () => {
  it("prepends a banner and appends 本地 clock to every turn header", () => {
    const raw = [
      "# 2026-08-07",
      "## Turn abc123 — 2026-08-07T07:09:00.000Z (user)",
      "hello",
      "## Turn abc123 — 2026-08-07T07:09:31.000Z (agent)",
      "hi",
    ].join("\n");
    const out = annotateSliceWithLocalTime(raw, TZ, "2026/08/07/0709");
    expect(out).toContain("> [时间] 该时间片发生于用户当地时间");
    expect(out).toContain("下方时间戳为原始 UTC");
    expect(out).toContain("（本地 15:09）");
    // Both headers annotated; original timestamps preserved.
    expect(out.match(/（本地 15:09）/g)).toHaveLength(2);
    expect(out).toContain("2026-08-07T07:09:00.000Z");
  });

  it("leaves content untouched when no turn headers exist", () => {
    const raw = "just some text\nno timestamps";
    const out = annotateSliceWithLocalTime(raw, TZ, "2026/08/07/0709");
    expect(out).toContain("> [时间]");
    expect(out).toContain("just some text");
  });
});
