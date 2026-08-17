/**
 * deterministicSliceMark — the close-marking reliability backstop.
 * Pure function, no I/O.
 */
import { describe, it, expect } from "vitest";
import { deterministicSliceMark } from "@/lib/episodic/slice-mark";
import type { TimeSlice } from "@/lib/episodic/types";

function slice(overrides: Partial<TimeSlice> = {}): TimeSlice {
  return {
    slice_id: "2026-08-11-1025",
    focus: "",
    status: "active",
    start: "2026-08-11T10:25:13.107Z",
    timezone: "Asia/Shanghai",
    summary: "",
    open_loops: [],
    decisions: [],
    tags: ["公司注册", "地址选择"],
    related_slices: [],
    loops: [],
    turns: [
      { timestamp: "2026-08-11T10:25:13.107Z", role: "user", content: "我想到一个问题 你能帮我查一下对这个实际办公地点有什么要求吗" },
      { timestamp: "2026-08-11T10:28:04.087Z", role: "agent", content: "好问题，不需要所有权。" },
    ],
    estimatedTokens: 100,
    ...overrides,
  };
}

describe("deterministicSliceMark", () => {
  it("builds focus from the first user turn's opening and summary from tags + count", () => {
    const mark = deterministicSliceMark(slice());
    expect(mark.focus).toContain("用户提到：我想到一个问题");
    expect(mark.focus).not.toContain("\n"); // single line
    expect(mark.summary).toBe("共 2 轮，涉及 公司注册、地址选择。");
  });

  it("truncates a long opening and appends an ellipsis", () => {
    const long = "测".repeat(100);
    const mark = deterministicSliceMark(slice({ turns: [{ timestamp: "t", role: "user", content: long }] }));
    expect(mark.focus).toBe(`用户提到：${"测".repeat(60)}…`);
  });

  it('falls back to "未标记话题" when the slice has no tags', () => {
    const mark = deterministicSliceMark(slice({ tags: [] }));
    expect(mark.summary).toContain("未标记话题");
  });

  it("never returns an empty focus when there is no user turn", () => {
    const mark = deterministicSliceMark(slice({ turns: [{ timestamp: "t", role: "agent", content: "hi" }] }));
    expect(mark.focus.length).toBeGreaterThan(0);
  });
});
