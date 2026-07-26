import { describe, it, expect } from "vitest";
import { applyPreviouslyAgentOutput } from "@/lib/episodic/previously-updater";
import type { PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";
import {
  newPreviouslyTemplate,
  serializePreviously,
} from "@/lib/episodic/previously-format";

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a doc with one identity belief and return its serialized form. */
function docWithIdentity(text: string, confidence: "high" | "medium" | "low" = "medium"): string {
  const sliceId = "2026-07-26-1226";
  return serializePreviously({
    sliceId,
    updated: "2026-07-26T12:00:00Z",
    longTerm: {
      identity: [
        {
          text,
          evidence: ["2026/07/24/1717-user-4"],
          confidence,
          updated: "2026-07-24",
          obs: confidence === "high" ? 6 : confidence === "low" ? 1 : 3,
        },
      ],
      patterns: [],
      strategies: [],
    },
    shortTerm: { context: [] },
  });
}

function docWithContext(text: string, expires?: string): string {
  const sliceId = "2026-07-26-1226";
  return serializePreviously({
    sliceId,
    updated: "2026-07-26T12:00:00Z",
    longTerm: { identity: [], patterns: [], strategies: [] },
    shortTerm: {
      context: [
        {
          text,
          evidence: ["2026/07/25/1859-arKZnw"],
          updated: "2026-07-26",
          expires: expires ?? "2026-08-02",
          obs: 1,
        },
      ],
    },
  });
}

function mutation(m: Partial<PreviouslyMutation> = {}): PreviouslyMutation {
  return {
    action: "observe",
    tier: "long",
    subsection: "identity",
    belief: "test belief",
    evidence_slice: "2026/07/26/1226",
    evidence_turn: "abc123",
    ...m,
  };
}

// ─── Empty mutations ────────────────────────────────────────────────────

describe("applyPreviouslyAgentOutput", () => {
  it("returns content unchanged when mutations array is empty", () => {
    const content = newPreviouslyTemplate("2026-07-26-1226");
    const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
    expect(result.content).toBe(content);
    expect(result.changes.added).toBe(0);
  });

  // ─── observe ──────────────────────────────────────────────────────────

  describe("observe", () => {
    it("adds a new long-term identity belief", () => {
      const content = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          tier: "long",
          subsection: "identity",
          belief: "用户是 Rust 工程师",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("用户是 Rust 工程师");
      expect(result.content).toContain("evidence:");
      expect(result.content).toContain("confidence: medium");
      expect(result.changes.added).toBe(1);
    });

    it("adds a new short-term context belief with expires", () => {
      const content = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          tier: "short",
          subsection: "context",
          belief: "用户正在装机",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("用户正在装机");
      expect(result.content).toContain("expires:");
      // Short-term should not have confidence
      const stSection = result.content.split("## 短期记忆")[1];
      expect(stSection).not.toContain("confidence:");
      expect(result.changes.added).toBe(1);
    });

    it("skips duplicate beliefs", () => {
      const content = docWithIdentity("用户是 Rust 工程师");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          tier: "long",
          subsection: "identity",
          belief: "用户是 Rust 工程师",
        }),
      ], "2026-07-26-1226");
      // Should not duplicate
      const count = (result.content.match(/用户是 Rust 工程师/g) ?? []).length;
      expect(count).toBe(1);
      expect(result.changes.added).toBe(0);
    });
  });

  // ─── reinforce ────────────────────────────────────────────────────────

  describe("reinforce", () => {
    it("bumps obs count and updates date", () => {
      const content = docWithIdentity("用户是 Rust 工程师");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "reinforce",
          tier: "long",
          subsection: "identity",
          belief_key: "Rust 工程师",
          evidence_slice: "2026/07/26/1226",
          evidence_turn: "xyz789",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("obs: 4"); // was 3, now 4
      expect(result.changes.reinforced).toBe(1);
    });

    it("promotes medium→high at obs >= 5", () => {
      const content = docWithIdentity("用户是 Rust 工程师", "medium");
      // Set obs to 4 so reinforce makes it 5
      const doc = {
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        longTerm: {
          identity: [
            {
              text: "用户是 Rust 工程师",
              evidence: ["2026/07/24/a"],
              confidence: "medium" as const,
              updated: "2026-07-24",
              obs: 4,
            },
          ],
          patterns: [],
          strategies: [],
        },
        shortTerm: { context: [] },
      };
      const customContent = serializePreviously(doc);
      const result = applyPreviouslyAgentOutput(customContent, [
        mutation({
          action: "reinforce",
          tier: "long",
          subsection: "identity",
          belief_key: "Rust 工程师",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("obs: 5");
      expect(result.content).toContain("confidence: high");
    });
  });

  // ─── contradict ───────────────────────────────────────────────────────

  describe("contradict", () => {
    it("drops confidence from high to medium", () => {
      const content = docWithIdentity("用户喜欢 Python", "high");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "contradict",
          tier: "long",
          subsection: "identity",
          belief_key: "喜欢 Python",
          note: "用户现在偏好 Rust",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("confidence: medium");
      expect(result.content).toContain("⚠️ 用户现在偏好 Rust");
      expect(result.changes.demoted).toBe(1);
    });
  });

  // ─── discard ──────────────────────────────────────────────────────────

  describe("discard", () => {
    it("removes a belief by key", () => {
      const content = docWithIdentity("用户喜欢 Python");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "discard",
          tier: "long",
          subsection: "identity",
          belief_key: "喜欢 Python",
        }),
      ], "2026-07-26-1226");
      expect(result.content).not.toContain("喜欢 Python");
      expect(result.changes.removed).toBe(1);
    });

    it("handles unknown key gracefully", () => {
      const content = docWithIdentity("用户喜欢 Python");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "discard",
          tier: "long",
          subsection: "identity",
          belief_key: "不存在的信念",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("喜欢 Python");
      expect(result.changes.removed).toBe(0);
    });
  });

  // ─── expire ───────────────────────────────────────────────────────────

  describe("expire", () => {
    it("removes an expired short-term belief", () => {
      const content = docWithContext("用户正在装机", "2026-07-20"); // already expired
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "expire",
          tier: "short",
          subsection: "context",
          belief_key: "装机",
        }),
      ], "2026-07-26-1226");
      expect(result.content).not.toContain("正在装机");
      expect(result.changes.removed).toBe(1);
    });
  });

  // ─── promote (short → long) ───────────────────────────────────────────

  describe("promote", () => {
    it("moves a belief from short-term to long-term", () => {
      const content = docWithContext("用户装机时偏好详细调研");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "promote",
          tier: "long",
          subsection: "patterns",
          belief_key: "详细调研",
          belief: "用户做技术决策前会充分调研",
          new_confidence: "high",
        }),
      ], "2026-07-26-1226");
      // Should be in long-term patterns now
      const ltSection = result.content.split("## 长期记忆")[1].split("## 短期记忆")[0];
      expect(ltSection).toContain("充分调研");
      expect(ltSection).toContain("confidence: high");
      // Should be removed from short-term
      const stSection = result.content.split("## 短期记忆")[1];
      expect(stSection).not.toContain("详细调研");
      expect(result.changes.added).toBe(1);
    });
  });

  // ─── demote (long → short) ────────────────────────────────────────────

  describe("demote", () => {
    it("moves long-term belief to short-term (full demote)", () => {
      const content = docWithIdentity("用户喜欢 Python", "low");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "demote",
          tier: "short",
          subsection: "context",
          belief_key: "喜欢 Python",
          belief: "用户之前偏好 Python，近期未再提及",
          new_confidence: "low",
        }),
      ], "2026-07-26-1226");
      // Should be removed from long-term identity
      const ltSection = result.content.split("## 长期记忆")[1].split("## 短期记忆")[0];
      expect(ltSection).not.toContain("喜欢 Python");
      // Should be in short-term context
      const stSection = result.content.split("## 短期记忆")[1];
      expect(stSection).toContain("用户之前偏好 Python");
      expect(stSection).toContain("expires:");
      expect(result.changes.demoted).toBe(1);
    });

    it("drops confidence only (no belief text)", () => {
      const content = docWithIdentity("用户喜欢 Python", "high");
      const result = applyPreviouslyAgentOutput(content, [
        {
          action: "demote" as const,
          tier: "long" as const,
          subsection: "identity" as const,
          belief_key: "喜欢 Python",
          new_confidence: "medium" as const,
        },
      ], "2026-07-26-1226");
      expect(result.content).toContain("confidence: medium");
      expect(result.changes.demoted).toBe(1);
    });
  });

  // ─── Quantity limits (R13) ────────────────────────────────────────────

  describe("enforceLimits", () => {
    it("trims patterns when over limit of 8", () => {
      const sliceId = "2026-07-26-1226";
      const patterns = Array.from({ length: 12 }, (_, i) => ({
        text: `模式 ${i + 1}`,
        evidence: ["2026/07/24/a"],
        confidence: "medium" as const,
        updated: "2026-07-20",
        obs: 1,
      }));
      const doc = {
        sliceId,
        updated: "2026-07-26T12:00:00Z",
        longTerm: { identity: [], patterns, strategies: [] },
        shortTerm: { context: [] },
      };
      const content = serializePreviously(doc);
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      // Should have exactly 8 patterns
      const parsed = result.content.split("### User patterns")[1].split("### Agent strategies")[0];
      const bulletCount = (parsed.match(/^- /gm) ?? []).length;
      expect(bulletCount).toBe(8);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles unparseable content by starting from template", () => {
      const result = applyPreviouslyAgentOutput(
        "not valid previously content",
        [
          mutation({
            action: "observe",
            tier: "long",
            subsection: "identity",
            belief: "用户是工程师",
          }),
        ],
        "2026-07-26-1226",
      );
      expect(result.content).toContain("# Previously On");
      expect(result.content).toContain("用户是工程师");
      expect(result.changes.added).toBe(1);
    });

    it("handles undefined evidence_slice gracefully", () => {
      const content = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(content, [
        {
          action: "observe",
          tier: "long",
          subsection: "identity",
          belief: "test",
          evidence_slice: undefined as unknown as string,
          evidence_turn: "abc",
        } as PreviouslyMutation,
      ], "2026-07-26-1226");
      expect(result.changes.added).toBe(1);
      expect(result.content).toContain("evidence:");
    });
  });
});
