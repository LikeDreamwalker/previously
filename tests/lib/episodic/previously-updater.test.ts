import { describe, it, expect } from "vitest";
import { applyPreviouslyAgentOutput } from "@/lib/episodic/previously-updater";
import type { PreviouslyMutation } from "@/lib/episodic/flash/previously-agent";
import {
  newPreviouslyTemplate,
  serializePreviously,
  parsePreviously,
  type PreviouslyDocument,
  type PreviouslyBelief,
} from "@/lib/episodic/previously-format";

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a doc with one profile.identity entry and return its serialized form. */
function docWithIdentity(text: string, confidence: "high" | "medium" | "low" = "medium"): string {
  return serializePreviously({
    sliceId: "2026-07-26-1226",
    updated: "2026-07-26T12:00:00Z",
    profile: {
      identity: [
        {
          text,
          refs: ["2026/07/24/1717-user-4"],
          confidence,
          updated: "2026-07-24",
          obs: confidence === "high" ? 6 : confidence === "low" ? 1 : 3,
        },
      ],
    },
    selfModel: {},
  });
}

/** Build a doc with one profile.current_state entry (short-lived). */
function docWithCurrentState(text: string, expires?: string): string {
  return serializePreviously({
    sliceId: "2026-07-26-1226",
    updated: "2026-07-26T12:00:00Z",
    profile: {
      current_state: [
        {
          text,
          refs: ["2026/07/25/1859-arKZnw"],
          updated: "2026-07-26",
          expires: expires ?? "2026-08-02",
          obs: 1,
        },
      ],
    },
    selfModel: {},
  });
}

function mutation(m: Partial<PreviouslyMutation> = {}): PreviouslyMutation {
  return {
    action: "observe",
    section: "profile",
    subsection: "identity",
    belief: "test belief",
    evidence_slice: "2026/07/26/1226",
    evidence_turn: "abc123",
    ...m,
  };
}

/** Count `- ` bullets in a profile subsection by its serialized header. */
function bulletCount(content: string, subsectionHeader: string): number {
  const doc = parsePreviously(content);
  if (!doc) return -1;
  const key = Object.keys(doc.profile).find((k) => {
    const labels: Record<string, string> = {
      identity: "Identity & background", work_style: "Work style", current_state: "Current state",
      tool_discipline: "Tool discipline",
    };
    return labels[k] === subsectionHeader;
  });
  if (!key) return -1;
  return (doc.profile[key as keyof typeof doc.profile]?.length ?? 0);
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
    it("adds a new profile.identity entry with refs", () => {
      const content = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          section: "profile",
          subsection: "identity",
          belief: "用户是 Rust 工程师",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("用户是 Rust 工程师");
      expect(result.content).toContain("refs: [2026/07/26/1226-abc123]");
      expect(result.content).toContain("confidence: medium");
      expect(result.changes.added).toBe(1);
    });

    it("adds a current_state entry with expires", () => {
      const content = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          section: "profile",
          subsection: "current_state",
          belief: "用户正在评估迁移到 Rust",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("用户正在评估迁移到 Rust");
      expect(result.content).toContain("expires:");
      expect(result.changes.added).toBe(1);
    });

    it("adds a self_model entry to tool_discipline", () => {
      const content = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          section: "self_model",
          subsection: "tool_discipline",
          belief: "涉具体 API 先 webSearch 验证",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("涉具体 API 先 webSearch 验证");
      expect(result.changes.added).toBe(1);
    });

    it("skips duplicate beliefs", () => {
      const content = docWithIdentity("用户是 Rust 工程师");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "observe",
          section: "profile",
          subsection: "identity",
          belief: "用户是 Rust 工程师",
        }),
      ], "2026-07-26-1226");
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
          section: "profile",
          subsection: "identity",
          belief_key: "Rust 工程师",
          evidence_slice: "2026/07/26/1226",
          evidence_turn: "xyz789",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("obs: 4"); // was 3, now 4
      expect(result.content).toContain("refs: [2026/07/24/1717-user-4], [2026/07/26/1226-xyz789]");
      expect(result.changes.reinforced).toBe(1);
    });

    it("promotes medium→high at obs >= 5", () => {
      const doc: PreviouslyDocument = {
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: {
          identity: [
            {
              text: "用户是 Rust 工程师",
              refs: ["2026/07/24/a"],
              confidence: "medium",
              updated: "2026-07-24",
              obs: 4,
            },
          ],
        },
        selfModel: {},
      };
      const result = applyPreviouslyAgentOutput(serializePreviously(doc), [
        mutation({
          action: "reinforce",
          section: "profile",
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
    it("drops confidence and records the refutation", () => {
      const content = docWithIdentity("用户喜欢 Python", "high");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "contradict",
          section: "profile",
          subsection: "identity",
          belief_key: "喜欢 Python",
          refuted_by: "用户说现在偏好 Rust",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("confidence: medium");
      expect(result.content).toContain("refuted_by: 用户说现在偏好 Rust");
      expect(result.changes.demoted).toBe(1);
    });
  });

  // ─── discard / expire ─────────────────────────────────────────────────

  describe("discard", () => {
    it("removes a belief by key", () => {
      const content = docWithIdentity("用户喜欢 Python");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "discard",
          section: "profile",
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
          section: "profile",
          subsection: "identity",
          belief_key: "不存在的信念",
        }),
      ], "2026-07-26-1226");
      expect(result.content).toContain("喜欢 Python");
      expect(result.changes.removed).toBe(0);
    });
  });

  describe("expire", () => {
    it("removes an expired current_state entry", () => {
      const content = docWithCurrentState("用户正在装机", "2026-07-20"); // already expired
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "expire",
          section: "profile",
          subsection: "current_state",
          belief_key: "装机",
        }),
      ], "2026-07-26-1226");
      expect(result.content).not.toContain("正在装机");
      expect(result.changes.removed).toBe(1);
    });
  });

  // ─── promote / demote ─────────────────────────────────────────────────

  describe("promote", () => {
    it("moves a current_state entry to a stable dimension", () => {
      const content = docWithCurrentState("用户装机时偏好详细调研");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "promote",
          section: "profile",
          subsection: "work_style",
          belief_key: "详细调研",
          belief: "用户做技术决策前会充分调研",
          new_confidence: "high",
        }),
      ], "2026-07-26-1226");
      expect(result.content).not.toContain("当前状态");
      expect(result.content).toContain("用户做技术决策前会充分调研");
      expect(result.content).toContain("### Work style");
      expect(result.content).toContain("confidence: high");
      expect(result.changes.added).toBe(1);
    });
  });

  describe("demote", () => {
    it("moves a stable entry to current_state with an expiry", () => {
      const content = docWithIdentity("用户偏好详细调研", "low");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "demote",
          section: "profile",
          subsection: "identity",
          belief_key: "详细调研",
          belief: "用户之前偏好详细调研，近期未再提及",
        }),
      ], "2026-07-26-1226");
      expect(result.content).not.toContain("### Identity & background");
      expect(result.content).toContain("用户之前偏好详细调研");
      expect(result.content).toContain("### Current state");
      expect(result.content).toContain("expires:");
      expect(result.changes.demoted).toBe(1);
    });

    it("rejects a self_model demote so an operating lesson never lands in the user profile", () => {
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: {},
        selfModel: {
          tool_discipline: [{
            text: "涉具体 API 先 webSearch 验证",
            refs: ["agent.md 2026/08/05/1403"],
            confidence: "medium",
            updated: "2026-08-05",
            obs: 1,
          }],
        },
      });
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "demote",
          section: "self_model",
          subsection: "tool_discipline",
          belief_key: "webSearch",
          belief: "不再适用的教训",
        }),
      ], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      // Lesson stays in selfModel.tool_discipline; nothing leaks into the user profile.
      expect(doc!.selfModel.tool_discipline?.[0].text).toContain("webSearch");
      expect(Object.keys(doc!.profile.current_state ?? {})).toHaveLength(0);
      expect(result.changes.demoted).toBe(0);
    });
  });

  describe("promote", () => {
    it("rejects a self_model promote — user context must not become an operating lesson", () => {
      const content = docWithCurrentState("用户装机时偏好详细调研");
      const result = applyPreviouslyAgentOutput(content, [
        mutation({
          action: "promote",
          section: "self_model",
          subsection: "tool_discipline",
          belief_key: "详细调研",
          belief: "用 checklists 拆解大任务",
        }),
      ], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      // The current_state entry stays put; no selfModel.tool_discipline entry is created.
      expect(doc!.profile.current_state?.[0].text).toContain("详细调研");
      expect(doc!.selfModel.tool_discipline ?? []).toHaveLength(0);
      expect(result.changes.added).toBe(0);
    });
  });

  // ─── reformat ─────────────────────────────────────────────────────────

  describe("reformat", () => {
    it("replaces the whole document when a valid v3 reformat is provided", () => {
      const original = docWithIdentity("过时条目");
      const replacement = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(
        original,
        [],
        "2026-07-26-1226",
        replacement,
      );
      expect(result.content).toBe(replacement);
      expect(result.changes.added).toBe(0);
      expect(result.reformatted).toBe(true);
    });

    it("falls through to mutations when the reformat is not parseable v3", () => {
      const original = docWithIdentity("保留条目");
      const result = applyPreviouslyAgentOutput(
        original,
        [
          mutation({
            action: "observe",
            section: "profile",
            subsection: "identity",
            belief: "新条目",
          }),
        ],
        "2026-07-26-1226",
        "not a real previously document",
      );
      expect(result.content).toContain("保留条目");
      expect(result.content).toContain("新条目");
      // An unparseable reformat must NOT be reported as a wholesale replacement.
      expect(result.reformatted).toBe(false);
    });

    it("does not report a reformat on a plain mutation pass", () => {
      const original = newPreviouslyTemplate("2026-07-26-1226");
      const result = applyPreviouslyAgentOutput(
        original,
        [
          mutation({
            action: "observe",
            section: "profile",
            subsection: "identity",
            belief: "用户是工程师",
          }),
        ],
        "2026-07-26-1226",
      );
      expect(result.reformatted).toBe(false);
    });
  });

  // ─── Quantity limits ──────────────────────────────────────────────────

  describe("limits", () => {
    it("trims profile when total exceeds 40", () => {
      const identity: PreviouslyBelief[] = Array.from({ length: 45 }, (_, i) => ({
        text: `身份条目 ${i + 1}`,
        refs: ["2026/07/24/a"],
        confidence: "medium",
        updated: "2026-07-20",
        obs: 1,
      }));
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: { identity },
        selfModel: {},
      });
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      const count = bulletCount(result.content, "Identity & background");
      expect(count).toBe(40);
    });

    it("trims self_model when total exceeds 30", () => {
      const toolDiscipline: PreviouslyBelief[] = Array.from({ length: 35 }, (_, i) => ({
        text: `工具教训 ${i + 1}`,
        refs: ["agent.md 2026/08/05/1403"],
        confidence: "medium",
        updated: "2026-07-20",
        obs: 1,
      }));
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: {},
        selfModel: { tool_discipline: toolDiscipline },
      });
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      expect(doc!.selfModel.tool_discipline?.length ?? 0).toBe(30);
    });

    it("prefers evicting low-confidence stale entries over fresh high-confidence ones", () => {
      const staleLow: PreviouslyBelief = {
        text: "过时低置信度",
        refs: ["2026/07/01/a"],
        confidence: "low",
        updated: "2026-07-01",
        obs: 1,
      };
      const freshHigh: PreviouslyBelief = {
        text: "新鲜高置信度",
        refs: ["2026/08/01/b"],
        confidence: "high",
        updated: "2026-08-01",
        obs: 1,
      };
      const entries: PreviouslyBelief[] = [
        staleLow,
        freshHigh,
        ...Array.from({ length: 40 }, (_, i) => ({
          text: `条目 ${i}`,
          refs: ["2026/07/20/c"],
          confidence: "medium" as const,
          updated: "2026-07-20",
          obs: 1,
        })),
      ];
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: { identity: entries },
        selfModel: {},
      });
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      const kept = doc!.profile.identity ?? [];
      expect(kept.length).toBe(40);
      expect(kept.some((b) => b.text === "新鲜高置信度")).toBe(true);
    });

    it("evicts an expired entry before a fresh one of equal confidence", () => {
      const entries: PreviouslyBelief[] = [
        {
          text: "已过期条目",
          refs: ["2026/07/20/a"],
          confidence: "medium",
          updated: "2026-07-20",
          obs: 1,
          expires: "2020-01-01", // long past
        },
        {
          text: "新鲜条目",
          refs: ["2026/08/01/b"],
          confidence: "medium",
          updated: "2026-08-01",
          obs: 1,
        },
        ...Array.from({ length: 40 }, (_, i) => ({
          text: `条目 ${i}`,
          refs: ["2026/07/20/c"],
          confidence: "medium" as const,
          updated: "2026-07-20",
          obs: 1,
        })),
      ];
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: { identity: entries },
        selfModel: {},
      });
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      const kept = doc!.profile.identity ?? [];
      expect(kept.length).toBe(40);
      expect(kept.some((b) => b.text === "已过期条目")).toBe(false);
      expect(kept.some((b) => b.text === "新鲜条目")).toBe(true);
    });

    it("does not corrupt eviction when an entry has an unparseable updated date", () => {
      const entries: PreviouslyBelief[] = Array.from({ length: 41 }, (_, i) => ({
        text: `条目 ${i}`,
        refs: ["2026/07/20/c"],
        confidence: "medium",
        updated: i === 0 ? "not-a-real-date" : "2026-07-20",
        obs: 1,
      }));
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: { identity: entries },
        selfModel: {},
      });
      // Must complete without NaN corrupting the sort — the unparseable entry
      // scores lowest (30-day fallback) and is the one evicted.
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      const kept = doc!.profile.identity ?? [];
      expect(kept.length).toBe(40);
      expect(kept.some((b) => b.updated === "not-a-real-date")).toBe(false);
    });

    it("caps current_state at 8 entries even when profile total is under 40", () => {
      const currentState: PreviouslyBelief[] = Array.from({ length: 12 }, (_, i) => ({
        text: `当前状态 ${i + 1}`,
        refs: ["2026/08/01/a"],
        confidence: "medium",
        updated: "2026-08-01",
        obs: 1,
        expires: "2026-08-15",
      }));
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: { current_state: currentState },
        selfModel: {},
      });
      const result = applyPreviouslyAgentOutput(content, [], "2026-07-26-1226");
      const doc = parsePreviously(result.content);
      expect(doc!.profile.current_state?.length ?? 0).toBe(8);
    });

    it("strips inline HTML comments from belief text", () => {
      // The agent has been observed writing `<!-- ⚠️ ... -->` INSIDE a belief
      // instead of using the structured refuted_by mechanism. Serialization
      // must strip it so the entry round-trips cleanly.
      const content = serializePreviously({
        sliceId: "2026-07-26-1226",
        updated: "2026-07-26T12:00:00Z",
        profile: {
          identity: [
            {
              text: "The user is interviewing at X. <!-- ⚠️ superseded -->",
              refs: ["2026/07/24/1717-user-4"],
              confidence: "medium",
              updated: "2026-07-24",
              obs: 1,
            },
          ],
        },
        selfModel: {},
      });
      const doc = parsePreviously(content);
      expect(doc!.profile.identity?.[0]?.text).toBe(
        "The user is interviewing at X.",
      );
      expect(content).not.toContain("<!--");
    });
  });

  // ─── Legacy fallback ──────────────────────────────────────────────────

  describe("legacy fallback", () => {
    it("migrates v2 content before applying mutations", () => {
      const v2 = `# Previously On

## 长期记忆

### User identity

- 用户是 Rust 工程师
  evidence: [2026/07/24/1717-user-4] | confidence: medium | updated: 2026-07-24 | obs: 2

## 短期记忆
`;
      const result = applyPreviouslyAgentOutput(v2, [], "2026-07-26-1226");
      expect(result.content).toContain("## User profile");
      expect(result.content).toContain("用户是 Rust 工程师");
    });
  });
});
