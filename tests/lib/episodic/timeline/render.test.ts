/**
 * Timeline renderers — deterministic markdown views of the catalog.
 * Pure functions, no I/O.
 */
import { describe, it, expect } from "vitest";
import {
  groupByEraAndDay,
  sliceLine,
  renderTimelineMd,
  buildTimelineBrief,
} from "@/lib/episodic/timeline/render";
import type { TimelineIndex, TimelineSliceEntry } from "@/lib/episodic/timeline/types";

function entry(overrides: Partial<TimelineSliceEntry> = {}): TimelineSliceEntry {
  return {
    id: "2026-08-11-1115",
    date: "2026-08-11",
    start: "2026-08-11T11:15:15.117Z",
    status: "closed",
    focus: "回顾滴滴时期绩效背锅，与当下对比",
    summary: "用户倾诉滴滴时期经历，探讨平行宇宙与命中注定",
    tags: ["状态回忆", "创伤克服"],
    open_loops: [],
    decisions: [],
    strands: ["状态回忆"],
    needs_marking: false,
    ...overrides,
  } as TimelineSliceEntry;
}

function index(slices: TimelineSliceEntry[]): TimelineIndex {
  return {
    _schema: 1,
    updated_at: "2026-08-12T00:00:00.000Z",
    slice_count: slices.length,
    needs_marking: slices.filter((s) => s.needs_marking).length,
    slices,
  };
}

describe("sliceLine", () => {
  it("renders the full resolvable id, focus, turns, tone and tags", () => {
    const line = sliceLine(entry({ turn_count: 4, tone: "mixed" }));
    expect(line).toContain("**2026-08-11-1115**");
    expect(line).toContain("回顾滴滴时期绩效背锅");
    expect(line).toContain("· 4轮");
    expect(line).toContain("· mixed");
    expect(line).toContain("[状态回忆,创伤克服]");
  });

  it('falls back to "*(无摘要)*" for a dry slice', () => {
    const line = sliceLine(entry({ focus: "", summary: "" }));
    expect(line).toContain("*(无摘要)*");
  });
});

describe("groupByEraAndDay", () => {
  it("groups newest era first, newest day within an era", () => {
    const slices = [
      entry({ id: "2026-07-24-1500", date: "2026-07-24" }),
      entry({ id: "2026-08-11-1115", date: "2026-08-11" }),
      entry({ id: "2026-08-10-1839", date: "2026-08-10" }),
    ];
    const eras = groupByEraAndDay(slices);
    expect(eras.map((e) => e.era)).toEqual(["2026-08", "2026-07"]);
    expect(eras[0].days.map((d) => d.day)).toEqual(["2026-08-11", "2026-08-10"]);
  });
});

describe("renderTimelineMd", () => {
  it("renders era + day headers and slice lines, newest first", () => {
    const md = renderTimelineMd(
      index([
        entry({ id: "2026-08-10-1839", date: "2026-08-10", focus: "地址研究" }),
        entry({ id: "2026-08-11-1115", date: "2026-08-11", focus: "滴滴反思" }),
      ]),
    );
    expect(md).toContain("# Timeline");
    expect(md).toContain("_Slices: 2_");
    expect(md).toContain("## 2026-08");
    expect(md).toContain("### 08-11");
    expect(md.indexOf("滴滴反思")).toBeLessThan(md.indexOf("地址研究")); // newest first
  });
});

describe("buildTimelineBrief", () => {
  it("lists recent slices with pointer lines and the total count", () => {
    const brief = buildTimelineBrief(
      index([
        entry({ id: "2026-08-10-1839", date: "2026-08-10", focus: "地址研究" }),
        entry({ id: "2026-08-11-1115", date: "2026-08-11", focus: "滴滴反思" }),
      ]),
      { recent: 1, locale: "zh" },
    );
    expect(brief).toContain("## Timeline (recent)");
    expect(brief).toContain("滴滴反思");
    expect(brief).not.toContain("地址研究"); // beyond the recent cap
    expect(brief).toContain("往前共 2 片");
  });

  it("renders the totals lines in English for en locale", () => {
    const brief = buildTimelineBrief(
      index([
        entry({ id: "2026-08-10-1839", date: "2026-08-10", focus: "地址研究" }),
        entry({ id: "2026-08-11-1115", date: "2026-08-11", focus: "滴滴反思", needs_marking: true }),
      ]),
      { recent: 1, locale: "en" },
    );
    expect(brief).toContain("2 slices in total");
    expect(brief).toContain("1 slice(s) not yet summarized");
  });

  it("notes slices still needing marking", () => {
    const brief = buildTimelineBrief(
      index([
        entry({ id: "2026-08-11-1025", date: "2026-08-11", focus: "", summary: "", needs_marking: true }),
      ]),
      { locale: "zh" },
    );
    expect(brief).toContain("1 片尚未生成摘要");
  });

  it("annotates pointer lines with local date + relative days when time context is given", () => {
    // now = 2026-08-17 06:00 UTC (Monday); the slice is 2026-08-11 11:15 UTC
    // = 19:15 local (Tuesday) in Asia/Shanghai — 6 days earlier.
    const brief = buildTimelineBrief(index([entry()]), {
      nowIso: "2026-08-17T06:00:00.000Z",
      timezone: "Asia/Shanghai",
      locale: "zh",
    });
    expect(brief).toContain("**2026-08-11-1115**（08-11 周二·6 天前）");
  });

  it("renders the en annotation when locale is en", () => {
    const brief = buildTimelineBrief(index([entry()]), {
      nowIso: "2026-08-17T06:00:00.000Z",
      timezone: "Asia/Shanghai",
      locale: "en",
    });
    expect(brief).toContain("**2026-08-11-1115** (08-11 Tue · 6 days ago)");
  });

  it("omits the annotation without time context (backwards compatible)", () => {
    const brief = buildTimelineBrief(index([entry()]));
    expect(brief).toContain("**2026-08-11-1115** 回顾滴滴时期绩效背锅");
  });
});

describe("buildTimelineBrief — frozen mode (v0.9, asOfSliceId)", () => {
  const CURRENT = "2026-08-17-1400";

  it("lists only slices CLOSED before the current slice began", () => {
    const brief = buildTimelineBrief(
      index([
        entry({ id: "2026-08-10-1839", date: "2026-08-10", focus: "地址研究" }),
        entry({ id: "2026-08-11-1115", date: "2026-08-11", focus: "滴滴反思" }),
        // The current slice itself (active, same id) — excluded.
        entry({ id: CURRENT, date: "2026-08-17", status: "active", focus: "当前片" }),
        // A slice started after the current one — excluded even if closed.
        entry({ id: "2026-08-17-1600", date: "2026-08-17", focus: "更晚的片" }),
        // An ACTIVE slice started before ours (other device) — excluded.
        entry({ id: "2026-08-12-0900", date: "2026-08-12", status: "active", focus: "进行中的片" }),
      ]),
      { asOfSliceId: CURRENT, timezone: "Asia/Shanghai", locale: "zh" },
    );
    expect(brief).toContain("滴滴反思");
    expect(brief).toContain("地址研究");
    expect(brief).not.toContain("当前片");
    expect(brief).not.toContain("更晚的片");
    expect(brief).not.toContain("进行中的片");
  });

  it("annotates with ABSOLUTE local dates — no relative phrasing, byte-stable", () => {
    const brief = buildTimelineBrief(index([entry()]), {
      asOfSliceId: CURRENT,
      timezone: "Asia/Shanghai",
      locale: "zh",
    });
    expect(brief).toContain("**2026-08-11-1115**（08-11 周二）");
    expect(brief).not.toContain("天前");
  });

  it("renders the en absolute annotation", () => {
    const brief = buildTimelineBrief(index([entry()]), {
      asOfSliceId: CURRENT,
      timezone: "Asia/Shanghai",
      locale: "en",
    });
    expect(brief).toContain("**2026-08-11-1115** (08-11 Tue)");
  });

  it("computes totals from the fixed pool, not the drifting catalog counters", () => {
    const idx = index([
      entry({ id: "2026-08-10-1839", date: "2026-08-10", focus: "地址研究", needs_marking: true }),
      entry({ id: "2026-08-11-1115", date: "2026-08-11", focus: "滴滴反思" }),
      // Newer slice inflating the catalog counters — must not leak into the brief.
      entry({ id: "2026-08-18-0900", date: "2026-08-18", focus: "新片", needs_marking: true }),
    ]);
    const brief = buildTimelineBrief(idx, {
      asOfSliceId: CURRENT,
      timezone: "Asia/Shanghai",
      locale: "zh",
      recent: 1,
    });
    expect(brief).toContain("往前共 2 片"); // pool size, not slice_count (3)
    expect(brief).toContain("1 片尚未生成摘要"); // only the pool's dry slice
  });

  it("is byte-identical when the catalog grows newer slices mid-slice", () => {
    const base = [entry({ id: "2026-08-11-1115", date: "2026-08-11" })];
    const grown = [
      ...base,
      entry({ id: "2026-08-17-1500", date: "2026-08-17", status: "active", focus: "别的设备" }),
    ];
    const opts = { asOfSliceId: CURRENT, timezone: "Asia/Shanghai", locale: "zh" } as const;
    expect(buildTimelineBrief(index(grown), opts)).toBe(buildTimelineBrief(index(base), opts));
  });
});
