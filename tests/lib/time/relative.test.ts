import { describe, it, expect } from "vitest";
import {
  normalizeLocale,
  localDateKey,
  dayDiff,
  weekdayLabel,
  relPhrase,
  relTag,
  annotateDate,
  annotateCardTimes,
  buildDateAnchors,
} from "@/lib/time/relative";

// now = 2026-08-17 06:00 UTC = 2026-08-17 14:00 in Asia/Shanghai (a Monday).
const NOW = "2026-08-17T06:00:00.000Z";
const TZ = "Asia/Shanghai";

describe("normalizeLocale", () => {
  it("maps zh variants to zh, everything else to en", () => {
    expect(normalizeLocale("zh")).toBe("zh");
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale("fr")).toBe("en");
  });
});

describe("localDateKey", () => {
  it("passes date-only input through untouched (it is already a calendar date)", () => {
    expect(localDateKey("2026-08-14", TZ)).toBe("2026-08-14");
    expect(localDateKey("2026-08-14", "America/New_York")).toBe("2026-08-14");
  });

  it("converts a UTC instant to the local calendar date", () => {
    // 2026-08-16 20:00 UTC is already 2026-08-17 04:00 in Shanghai.
    expect(localDateKey("2026-08-16T20:00:00.000Z", TZ)).toBe("2026-08-17");
    expect(localDateKey("2026-08-16T20:00:00.000Z", "UTC")).toBe("2026-08-16");
  });

  it("returns null for invalid input and never throws", () => {
    expect(localDateKey("garbage", TZ)).toBeNull();
    expect(localDateKey("", TZ)).toBeNull();
    expect(localDateKey("2026-13-40T99:99:99Z", TZ)).toBeNull();
  });

  it("degrades an unknown timezone to UTC", () => {
    expect(localDateKey("2026-08-16T20:00:00.000Z", "Not/AZone")).toBe(
      "2026-08-16",
    );
  });
});

describe("dayDiff / weekdayLabel", () => {
  it("computes whole-day differences", () => {
    expect(dayDiff("2026-08-17", "2026-08-17")).toBe(0);
    expect(dayDiff("2026-08-18", "2026-08-17")).toBe(1);
    expect(dayDiff("2026-08-10", "2026-08-17")).toBe(-7);
    expect(dayDiff("bad", "2026-08-17")).toBeNull();
  });

  it("labels weekdays in both locales (2026-08-17 is a Monday)", () => {
    expect(weekdayLabel("2026-08-17", "zh")).toBe("周一");
    expect(weekdayLabel("2026-08-17", "en")).toBe("Mon");
    expect(weekdayLabel("2026-08-14", "zh")).toBe("周五");
    expect(weekdayLabel("2026-08-14", "en")).toBe("Fri");
    expect(weekdayLabel("nope", "zh")).toBe("");
  });
});

describe("relPhrase — boundaries", () => {
  it("today / tomorrow / yesterday", () => {
    expect(relPhrase("2026-08-17", NOW, TZ, "zh")).toBe("今天");
    expect(relPhrase("2026-08-18", NOW, TZ, "zh")).toBe("明天");
    expect(relPhrase("2026-08-16", NOW, TZ, "zh")).toBe("昨天");
    expect(relPhrase("2026-08-17", NOW, TZ, "en")).toBe("today");
    expect(relPhrase("2026-08-18", NOW, TZ, "en")).toBe("tomorrow");
    expect(relPhrase("2026-08-16", NOW, TZ, "en")).toBe("yesterday");
  });

  it("±N days with weekday when requested", () => {
    expect(relPhrase("2026-08-14", NOW, TZ, "zh", { weekday: true })).toBe(
      "周五·3 天前",
    );
    expect(relPhrase("2026-08-14", NOW, TZ, "en", { weekday: true })).toBe(
      "Fri · 3 days ago",
    );
    expect(relPhrase("2026-08-22", NOW, TZ, "zh", { weekday: true })).toBe(
      "周六·5 天后",
    );
    expect(relPhrase("2026-08-22", NOW, TZ, "en", { weekday: true })).toBe(
      "Sat · in 5 days",
    );
  });

  it("week-scale beyond 14 days", () => {
    expect(relPhrase("2026-07-20", NOW, TZ, "zh")).toBe("4 周前");
    expect(relPhrase("2026-07-20", NOW, TZ, "en")).toBe("4 weeks ago");
    expect(relPhrase("2026-09-07", NOW, TZ, "zh")).toBe("3 周后");
    expect(relPhrase("2026-09-07", NOW, TZ, "en")).toBe("in 3 weeks");
  });

  it("due style for deadlines", () => {
    expect(relPhrase("2026-08-17", NOW, TZ, "zh", { due: true })).toBe("今天到期");
    expect(relPhrase("2026-08-18", NOW, TZ, "zh", { due: true })).toBe("明天到期");
    expect(relPhrase("2026-08-22", NOW, TZ, "zh", { due: true })).toBe("还剩 5 天");
    expect(relPhrase("2026-08-15", NOW, TZ, "zh", { due: true })).toBe("已逾期 2 天");
    expect(relPhrase("2026-08-22", NOW, TZ, "en", { due: true })).toBe("in 5 days");
    expect(relPhrase("2026-08-16", NOW, TZ, "en", { due: true })).toBe("1 day overdue");
    expect(relPhrase("2026-08-15", NOW, TZ, "en", { due: true })).toBe("2 days overdue");
  });

  it("returns '' for invalid input instead of throwing", () => {
    expect(relPhrase("garbage", NOW, TZ, "zh")).toBe("");
    expect(relPhrase("2026-08-17", "not-a-date", TZ, "zh")).toBe("");
  });
});

describe("relTag / annotateDate", () => {
  it("wraps in locale-appropriate parentheses", () => {
    expect(relTag("2026-08-14", NOW, TZ, "zh")).toBe("（3 天前）");
    expect(relTag("2026-08-14", NOW, TZ, "en")).toBe("(3 days ago)");
    expect(relTag("2026-08-17", NOW, TZ, "zh")).toBe("（今天）");
    expect(relTag("2026-08-18", NOW, TZ, "en")).toBe("(tomorrow)");
    expect(relTag("bad", NOW, TZ, "zh")).toBe("");
  });

  it("annotates with local date + weekday", () => {
    expect(annotateDate("2026-08-14", NOW, TZ, "zh")).toBe(
      "2026-08-14（周五·3 天前）",
    );
    expect(annotateDate("2026-08-14", NOW, TZ, "en")).toBe(
      "2026-08-14 (Fri · 3 days ago)",
    );
  });

  it("returns the input unchanged when unparseable", () => {
    expect(annotateDate("not a date", NOW, TZ, "zh")).toBe("not a date");
  });
});

describe("annotateCardTimes", () => {
  const card = [
    "## Now",
    "",
    "- Preparing the demo — refs: [2026/08/14/1000] | since: 2026-08-14",
    "",
    "## Horizon",
    "",
    "- Ship the release — by: 2026-08-22 — refs: [2026/08/10/0900]",
    "- Renew the domain — by: 2026-08-15 — refs: [2026/08/01/0900]",
  ].join("\n");

  it("annotates since: (relative past) and by: (due style) — zh", () => {
    const out = annotateCardTimes(card, NOW, TZ, "zh");
    expect(out).toContain("since: 2026-08-14（3 天前）");
    expect(out).toContain("by: 2026-08-22（还剩 5 天）");
    expect(out).toContain("by: 2026-08-15（已逾期 2 天）");
  });

  it("annotates in en", () => {
    const out = annotateCardTimes(card, NOW, TZ, "en");
    expect(out).toContain("since: 2026-08-14 (3 days ago)");
    expect(out).toContain("by: 2026-08-22 (in 5 days)");
    expect(out).toContain("by: 2026-08-15 (2 days overdue)");
  });

  it("leaves unparseable or absent dates untouched", () => {
    const messy = "- x | since: soon\n- y — by: whenever";
    expect(annotateCardTimes(messy, NOW, TZ, "zh")).toBe(messy);
    expect(annotateCardTimes("", NOW, TZ, "zh")).toBe("");
  });
});

describe("buildDateAnchors", () => {
  it("renders the zh anchor table (2026-08-17 is a Monday)", () => {
    expect(buildDateAnchors(NOW, TZ, "zh")).toEqual([
      "今天：2026-08-17（周一）",
      "本周一：2026-08-17",
      "上周：2026-08-10（周一） 至 2026-08-16（周日）",
      "明天：2026-08-18（周二）",
      "本周末：2026-08-22（周六） 至 2026-08-23（周日）",
    ]);
  });

  it("renders the en anchor table", () => {
    expect(buildDateAnchors(NOW, TZ, "en")).toEqual([
      "Today: 2026-08-17 (Mon)",
      "This week's Monday: 2026-08-17",
      "Last week: 2026-08-10 (Mon) → 2026-08-16 (Sun)",
      "Tomorrow: 2026-08-18 (Tue)",
      "This weekend: 2026-08-22 (Sat) → 2026-08-23 (Sun)",
    ]);
  });

  it("anchors mid-week correctly (2026-08-20 is a Thursday)", () => {
    const anchors = buildDateAnchors("2026-08-20T06:00:00.000Z", TZ, "en");
    expect(anchors[0]).toBe("Today: 2026-08-20 (Thu)");
    expect(anchors[1]).toBe("This week's Monday: 2026-08-17");
    expect(anchors[2]).toBe("Last week: 2026-08-10 (Mon) → 2026-08-16 (Sun)");
  });

  it("returns [] for an unparseable now", () => {
    expect(buildDateAnchors("nope", TZ, "zh")).toEqual([]);
  });
});
