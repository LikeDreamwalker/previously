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
      { recent: 1 },
    );
    expect(brief).toContain("## Timeline (recent)");
    expect(brief).toContain("滴滴反思");
    expect(brief).not.toContain("地址研究"); // beyond the recent cap
    expect(brief).toContain("往前共 2 片");
  });

  it("notes slices still needing marking", () => {
    const brief = buildTimelineBrief(
      index([
        entry({ id: "2026-08-11-1025", date: "2026-08-11", focus: "", summary: "", needs_marking: true }),
      ]),
    );
    expect(brief).toContain("1 片尚未生成摘要");
  });
});
