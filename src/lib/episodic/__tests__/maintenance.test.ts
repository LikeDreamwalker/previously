import { describe, it, expect } from "vitest";
import { applyMetadataUpdates, applyBeliefUpdates } from "../maintenance";
import type { SliceMetadata, BeliefUpdate } from "../maintenance";

function makeMeta(overrides: Partial<SliceMetadata> = {}): SliceMetadata {
  return {
    slice_id: "2024-03-15",
    focus: "Original focus",
    summary: "Original summary",
    open_loops: ["loop-1"],
    decisions: ["decision-1"],
    tags: ["work"],
    emotional_tone: "neutral",
    ...overrides,
  };
}

describe("applyMetadataUpdates", () => {
  it("does nothing when updates is null", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, null);
    expect(meta.focus).toBe("Original focus");
    expect(meta.summary).toBe("Original summary");
    expect(meta.open_loops).toEqual(["loop-1"]);
    expect(meta.decisions).toEqual(["decision-1"]);
    expect(meta.tags).toEqual(["work"]);
    expect(meta.emotional_tone).toBe("neutral");
  });

  it("updates only provided fields", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { focus: "New focus" });
    expect(meta.focus).toBe("New focus");
    expect(meta.summary).toBe("Original summary"); // unchanged
  });

  it("updates all fields when all provided", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, {
      focus: "New focus",
      summary: "New summary",
      open_loops: ["loop-2", "loop-3"],
      decisions: ["decision-2"],
      tags: ["personal"],
      emotional_tone: "positive",
    });
    expect(meta.focus).toBe("New focus");
    expect(meta.summary).toBe("New summary");
    expect(meta.open_loops).toEqual(["loop-2", "loop-3"]);
    expect(meta.decisions).toEqual(["decision-2"]);
    expect(meta.tags).toEqual(["personal"]);
    expect(meta.emotional_tone).toBe("positive");
  });

  it("clears array field when set to null", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { open_loops: null });
    expect(meta.open_loops).toEqual([]);
  });

  it("clears string field when set to null", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { focus: null });
    expect(meta.focus).toBe("");
  });

  it("does not clear field when undefined (omitted)", () => {
    const meta = makeMeta({ focus: "Keep me" });
    applyMetadataUpdates(meta, { summary: "Updated" });
    // focus is undefined in updates, should not be touched
    expect(meta.focus).toBe("Keep me");
    expect(meta.summary).toBe("Updated");
  });

  it("handles empty updates object", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, {});
    expect(meta.focus).toBe("Original focus");
  });

  it("preserves slice_id through updates", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { focus: "Changed" });
    expect(meta.slice_id).toBe("2024-03-15");
  });
});

// ─── applyBeliefUpdates ─────────────────────────────────────────────────

const SAMPLE_PREVIOUSLY = `# Agent Beliefs

_Active slice: 2026-07-24-1500 | Last updated: Turn a3fk2w_

## User identity (factual beliefs — user explicitly stated these)
- 自称 Alan Yuan
  (来源: 2026/07/11/0505-T1，用户原话)

## User patterns (pattern beliefs — agent observed these)
- 偏好简洁结构化的回答
  (置信度: 中 | 首次: 2026/07/14/1435-T2 | 最近: 2026/07/23/1445-T2 | 观察: 4)
- 偏好 Rust > Python
  (置信度: 高 | 首次: 2026/07/14/1005-T3 | 最近: 2026/07/24/1430-T1 | 观察: 8)

## Agent strategies (derived from beliefs above)
- 给出选项而非单一答案
  (来源: User patterns — 偏好简洁 + 2026/07/23/1445-T2 用户确认)
`;

describe("applyBeliefUpdates", () => {
  it("returns content unchanged when updates array is empty", () => {
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, [], "2026-07-25-1000");
    expect(result).toBe(SAMPLE_PREVIOUSLY);
  });

  it("adds a new belief (observe) to User patterns with 中 confidence", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "observe",
        section: "User patterns",
        belief: "深夜也会工作，但回复更简短",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    expect(result).toContain("深夜也会工作，但回复更简短");
    expect(result).toContain("置信度: 中");
    expect(result).toContain("观察: 1");
    expect(result).toContain("首次: 2026/07/25/1000-x7_y9z");
  });

  it("adds a new belief (observe) to User identity with 来源 format", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "observe",
        section: "User identity",
        belief: "偏好用中文交流",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    expect(result).toContain("偏好用中文交流");
    expect(result).toContain("来源: 2026/07/25/1000-x7_y9z，用户原话");
    // Should NOT have 置信度 (that's for patterns, not identity)
    const afterIdentity = result.split("## User patterns")[0];
    expect(afterIdentity).not.toContain("置信度");
  });

  it("reinforces an existing belief (bumps count, updates date)", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "reinforce",
        section: "User patterns",
        belief_key: "偏好简洁结构化的回答",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    // Observation count bumped from 4 to 5
    expect(result).toContain("观察: 5");
    // Date updated
    expect(result).toContain("最近: 2026/07/25/1000-x7_y9z");
    // Confidence promoted 中→高 (≥5 observations)
    expect(result).toContain("置信度: 高");
  });

  it("promotes 中→高 when observations reach 5", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-24-1500 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 某个模式
  (置信度: 中 | 首次: 2026/07/14/1435-T2 | 最近: 2026/07/23/1445-T2 | 观察: 4)
`;
    const updates: BeliefUpdate[] = [
      {
        action: "reinforce",
        section: "User patterns",
        belief_key: "某个模式",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
      },
    ];
    const result = applyBeliefUpdates(content, updates, "2026-07-25-1000");
    expect(result).toContain("置信度: 高");
    expect(result).toContain("观察: 5");
  });

  it("contradicts a belief (drops confidence, adds note)", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "contradict",
        section: "User patterns",
        belief_key: "偏好 Rust > Python",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
        note: "用户这次选择用 Python 做数据分析",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    // Confidence dropped 高→中
    expect(result).toContain("置信度: 中");
    // Note added
    expect(result).toContain("矛盾: 用户这次选择用 Python 做数据分析");
  });

  it("discards a belief (removes bullet + annotation)", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "discard",
        section: "User patterns",
        belief_key: "偏好 Rust > Python",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
        reason: "belief no longer supported",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    // Belief removed
    expect(result).not.toContain("偏好 Rust > Python");
    expect(result).not.toContain("观察: 8");
    // Other beliefs survive
    expect(result).toContain("偏好简洁结构化的回答");
    expect(result).toContain("自称 Alan Yuan");
  });

  it("handles unknown belief_key gracefully (no match → no crash)", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "reinforce",
        section: "User patterns",
        belief_key: "这个信念根本不存在",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    // Content should be substantially the same (except header update)
    expect(result).toContain("偏好简洁结构化的回答");
    expect(result).toContain("偏好 Rust > Python");
  });

  it("updates the active slice header", () => {
    const updates: BeliefUpdate[] = [
      {
        action: "reinforce",
        section: "User patterns",
        belief_key: "偏好简洁",
        evidence_slice: "2026/07/25/1000",
        evidence_turn: "x7_y9z",
      },
    ];
    const result = applyBeliefUpdates(SAMPLE_PREVIOUSLY, updates, "2026-07-25-1000");
    expect(result).toContain("_Active slice: 2026-07-25-1000");
  });

  it("Fix #5: clears _No beliefs yet._ from sections with existing beliefs even when not mutated this round", () => {
    // Simulate: User patterns has beliefs but only User identity gets a mutation this round.
    // The placeholder in User patterns should still be cleared.
    const content = `# Agent Beliefs

_Active slice: 2026-07-24-1500 | Last updated: Turn a3fk2w_

## User identity (factual beliefs — user explicitly stated these)

_No beliefs yet._

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

- 喜欢在深夜工作
  (置信度: 高 | 首次: 2026/07/25/1000-x7_y9z | 最近: 2026/07/25/1000-x7_y9z | 观察: 6)

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const updates: BeliefUpdate[] = [
      {
        action: "observe",
        section: "User identity",
        belief: "偏好用中文交流",
        evidence_slice: "2026/07/26/1200",
        evidence_turn: "a9b8c",
      },
    ];
    const result = applyBeliefUpdates(content, updates, "2026-07-26-1200");
    // User identity placeholder cleared (receiving mutation)
    expect(result).not.toContain("_No beliefs yet._\n\n- 偏好用中文交流");
    // User patterns placeholder ALSO cleared (has beliefs, even though not mutated)
    const patternsSection = result.split("## User patterns")[1].split("## Agent strategies")[0];
    expect(patternsSection).not.toContain("_No beliefs yet._");
    expect(patternsSection).toContain("喜欢在深夜工作");
    // Agent strategies placeholder KEPT (no beliefs)
    expect(result).toContain("_No beliefs yet._");
  });

  it("Fix #4: strips undefined- prefix from existing content", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-25-1730 | Last updated: Turn dCNovA_

## User identity (factual beliefs — user explicitly stated these)

- 用户正在了解背插主板
  (来源: undefined-2026-07-25-1730-dCNovA，用户原话)

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    // No updates — just verify the undefined- prefix is cleaned up
    const result = applyBeliefUpdates(content, [], "2026-07-26-1200");
    // Should NOT contain undefined- prefix
    expect(result).not.toContain("undefined-");
    // Should contain the corrected annotation
    expect(result).toContain("(来源: 2026-07-25-1730-dCNovA，用户原话)");
  });

  it("Fix #4: falls back to currentSliceId when evidence_slice is missing", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-26-1200 | Last updated: Turn a1b2c_

## User identity (factual beliefs — user explicitly stated these)

_No beliefs yet._

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const updates: BeliefUpdate[] = [
      {
        action: "observe",
        section: "User identity",
        belief: "用户正在装机",
        // evidence_slice deliberately omitted
        evidence_slice: "" as unknown as string, // simulate missing field
        evidence_turn: "x9y8z",
      },
    ];
    const result = applyBeliefUpdates(content, updates, "2026-07-26-1200");
    // Should use the fallback (currentSliceId converted to path format)
    expect(result).toContain("(来源: 2026/07/26/1200-x9y8z，用户原话)");
    // Should NOT contain undefined
    expect(result).not.toContain("undefined");
  });

  it("Fix #3: skips duplicate belief observations", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-25-1859 | Last updated: Turn LiOQ5A_

## User identity (factual beliefs — user explicitly stated these)

- 用户正在了解背插主板的未来趋势
  (来源: 2026-07-25-1859-LiOQ5A，用户原话)

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    // Flash emits the same belief twice (duplicate)
    const updates: BeliefUpdate[] = [
      {
        action: "observe",
        section: "User identity",
        belief: "用户正在了解背插主板的未来趋势",
        evidence_slice: "2026/07/26/1200",
        evidence_turn: "a1b2c",
      },
    ];
    const result = applyBeliefUpdates(content, updates, "2026-07-26-1200");
    // The belief should appear exactly once
    const count = (result.match(/背插主板的未来趋势/g) ?? []).length;
    expect(count).toBe(1);
  });
});

