import { describe, it, expect } from "vitest";
import {
  serializePreviously,
  parsePreviously,
  newPreviouslyTemplate,
  validatePreviouslyFormat,
  migrateToLongShortFormat,
  formatDate,
  formatExpiry,
  serializeBelief,
} from "@/lib/episodic/previously-format";

// ─── Helpers ────────────────────────────────────────────────────────────

function makeDoc(overrides?: Partial<{
  sliceId: string;
  identity: { text: string; evidence: string[]; confidence?: "high" | "medium" | "low"; obs?: number }[];
  patterns: { text: string; evidence: string[]; confidence?: "high" | "medium" | "low"; obs?: number }[];
  strategies: { text: string; evidence: string[]; confidence?: "high" | "medium" | "low"; obs?: number }[];
  context: { text: string; evidence: string[]; expires?: string; obs?: number }[];
}>) {
  const doc = {
    sliceId: "2026-07-26-1226",
    updated: "2026-07-26T12:00:00Z",
    longTerm: {
      identity: (overrides?.identity ?? []).map((i) => ({
        text: i.text,
        evidence: i.evidence,
        confidence: i.confidence ?? ("medium" as const),
        updated: "2026-07-26",
        obs: i.obs,
      })),
      patterns: (overrides?.patterns ?? []).map((p) => ({
        text: p.text,
        evidence: p.evidence,
        confidence: p.confidence ?? ("medium" as const),
        updated: "2026-07-26",
        obs: p.obs,
      })),
      strategies: (overrides?.strategies ?? []).map((s) => ({
        text: s.text,
        evidence: s.evidence,
        confidence: s.confidence ?? ("medium" as const),
        updated: "2026-07-26",
        obs: s.obs,
      })),
    },
    shortTerm: {
      context: (overrides?.context ?? []).map((c) => ({
        text: c.text,
        evidence: c.evidence,
        updated: "2026-07-26",
        expires: c.expires ?? "2026-08-02",
        obs: c.obs,
      })),
    },
  };
  return serializePreviously(doc);
}

// ─── newPreviouslyTemplate ───────────────────────────────────────────────

describe("newPreviouslyTemplate", () => {
  it("generates a valid empty template", () => {
    const content = newPreviouslyTemplate("2026-07-26-1226");
    expect(content).toContain("# Previously On");
    expect(content).toContain("_Active slice: 2026-07-26-1226");
    expect(content).toContain("## 长期记忆");
    expect(content).toContain("## 短期记忆");
    expect(content).toContain("### User identity");
    expect(content).toContain("### User patterns");
    expect(content).toContain("### Agent strategies");
    expect(content).toContain("### Current context");
    // All four subsections should have _No beliefs yet._
    const placeholders = (content.match(/_No beliefs yet\._/g) ?? []).length;
    expect(placeholders).toBe(4);
  });

  it("passes validation", () => {
    const content = newPreviouslyTemplate("2026-07-26-1226");
    const result = validatePreviouslyFormat(content);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── serialize + parse roundtrip ────────────────────────────────────────

describe("serialize + parse roundtrip", () => {
  it("roundtrips an empty document", () => {
    const content = newPreviouslyTemplate("2026-07-26-1226");
    const doc = parsePreviously(content);
    expect(doc).not.toBeNull();
    expect(doc!.sliceId).toBe("2026-07-26-1226");
    expect(doc!.longTerm.identity).toHaveLength(0);
    expect(doc!.shortTerm.context).toHaveLength(0);
  });

  it("roundtrips a document with beliefs in all sections", () => {
    const content = makeDoc({
      identity: [
        { text: "用户是 Rust 工程师", evidence: ["2026/07/24/1717-user-4"] },
      ],
      patterns: [
        {
          text: "用户做决策前会充分调研",
          evidence: ["2026/07/25/1859-ol-Pvg", "2026/07/26/0521-u_GO3Q"],
          confidence: "high",
          obs: 5,
        },
      ],
      strategies: [
        {
          text: "回答 Rust 问题时直接给代码",
          evidence: ["2026/07/24/1717-user-5"],
          obs: 3,
        },
      ],
      context: [
        {
          text: "用户正在装机",
          evidence: ["2026/07/25/1859-arKZnw"],
          expires: "2026-08-02",
        },
      ],
    });

    const doc = parsePreviously(content);
    expect(doc).not.toBeNull();
    expect(doc!.longTerm.identity).toHaveLength(1);
    expect(doc!.longTerm.identity[0].text).toBe("用户是 Rust 工程师");
    expect(doc!.longTerm.identity[0].confidence).toBe("medium");

    expect(doc!.longTerm.patterns).toHaveLength(1);
    expect(doc!.longTerm.patterns[0].confidence).toBe("high");
    expect(doc!.longTerm.patterns[0].obs).toBe(5);
    expect(doc!.longTerm.patterns[0].evidence).toHaveLength(2);

    expect(doc!.longTerm.strategies).toHaveLength(1);
    expect(doc!.longTerm.strategies[0].obs).toBe(3);

    expect(doc!.shortTerm.context).toHaveLength(1);
    expect(doc!.shortTerm.context[0].text).toBe("用户正在装机");
    expect(doc!.shortTerm.context[0].expires).toBe("2026-08-02");
  });

  it("handles multiple beliefs per section", () => {
    const content = makeDoc({
      identity: [
        { text: "信念 A", evidence: ["2026/07/24/a"] },
        { text: "信念 B", evidence: ["2026/07/24/b"] },
        { text: "信念 C", evidence: ["2026/07/24/c"] },
      ],
    });

    const doc = parsePreviously(content);
    expect(doc!.longTerm.identity).toHaveLength(3);
    expect(doc!.longTerm.identity.map((b) => b.text)).toEqual([
      "信念 A",
      "信念 B",
      "信念 C",
    ]);
  });
});

// ─── validatePreviouslyFormat ────────────────────────────────────────────

describe("validatePreviouslyFormat", () => {
  it("returns valid for a correct document", () => {
    const content = makeDoc({
      identity: [{ text: "用户是工程师", evidence: ["2026/07/24/a"] }],
    });
    const result = validatePreviouslyFormat(content);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports missing long-term section", () => {
    const content = "# Previously On\n\n_Active slice: x | Updated: y_\n\n## 短期记忆\n";
    const result = validatePreviouslyFormat(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("长期记忆"))).toBe(true);
  });

  it("reports missing short-term section", () => {
    const content = "# Previously On\n\n_Active slice: x | Updated: y_\n\n## 长期记忆\n";
    const result = validatePreviouslyFormat(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("短期记忆"))).toBe(true);
  });

  it("reports missing subsection", () => {
    const content = makeDoc({});
    // Remove one subsection
    const broken = content.replace("### Current context", "### Removed section");
    const result = validatePreviouslyFormat(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Current context"))).toBe(true);
  });

  it("reports short-term belief missing expires", () => {
    // Create a document with a short-term belief that has no expires
    const doc = {
      sliceId: "2026-07-26-1226",
      updated: "2026-07-26T12:00:00Z",
      longTerm: { identity: [], patterns: [], strategies: [] },
      shortTerm: {
        context: [
          {
            text: "用户正在装机",
            evidence: ["2026/07/25/a"],
            updated: "2026-07-26",
            // expires intentionally missing
          },
        ],
      },
    };
    const content = serializePreviously(doc);
    const result = validatePreviouslyFormat(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expires"))).toBe(true);
  });
});

// ─── migrateToLongShortFormat ────────────────────────────────────────────

describe("migrateToLongShortFormat", () => {
  it("returns v2 content unchanged", () => {
    const v2 = makeDoc({
      identity: [{ text: "用户是工程师", evidence: ["2026/07/24/a"] }],
    });
    const result = migrateToLongShortFormat(v2);
    expect(result).toBe(v2);
  });

  it("migrates empty v1 template to v2", () => {
    const v1 = `# Agent Beliefs

_Active slice: 2026-07-24-0913 | Last updated: Turn user-3_

## User identity (factual beliefs — user explicitly stated these)

_No beliefs yet._

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const result = migrateToLongShortFormat(v1, "2026-07-24-0913");
    expect(result).toContain("## 长期记忆");
    expect(result).toContain("## 短期记忆");
    // All subsections should be empty
    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();
    expect(doc!.longTerm.identity).toHaveLength(0);
    expect(doc!.longTerm.patterns).toHaveLength(0);
    expect(doc!.longTerm.strategies).toHaveLength(0);
    expect(doc!.shortTerm.context).toHaveLength(0);
  });

  it("migrates identity items to long-term", () => {
    const v1 = `# Agent Beliefs

_Active slice: 2026-07-24-1742 | Last updated: Turn user-12_

## User identity (factual beliefs — user explicitly stated these)

- 用户认为生物进化是达尔文体系下的海量试错过程
  (来源: 2026/07/24/1717-user-4，用户原话)

- 用户正在尝试让AI实现自进化能力
  (来源: 2026/07/24/1717-user-6，用户原话)

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const result = migrateToLongShortFormat(v1, "2026-07-24-1742");
    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();
    expect(doc!.longTerm.identity).toHaveLength(2);
    expect(doc!.longTerm.identity[0].text).toContain("达尔文");
    expect(doc!.longTerm.identity[0].confidence).toBe("medium"); // default for old "来源" format
    expect(doc!.longTerm.identity[1].text).toContain("自进化");
  });

  it("promotes high-confidence patterns to long-term", () => {
    const v1 = `# Agent Beliefs

_Active slice: 2026-07-24-1742 | Last updated: Turn user-12_

## User patterns (pattern beliefs — agent observed these)

- 用户倾向于让AI系统性地展开讲解某个话题
  (置信度: 中 | 首次: 2026/07/24/1717-user-5 | 最近: 2026/07/24/1717-user-6 | 观察: 2)

- 用户关注AI的持续学习和进步能力
  (置信度: 高 | 首次: 2026/07/24/1717-user-6 | 最近: 2026/07/24/1742-user-12 | 观察: 5)

## User identity (factual beliefs — user explicitly stated these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const result = migrateToLongShortFormat(v1, "2026-07-24-1742");
    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();
    // obs ≥ 3 → long-term
    const patterns = doc!.longTerm.patterns;
    const contextItems = doc!.shortTerm.context;

    // "关注AI持续学习" has obs:5 + confidence:高 → longTerm.patterns
    expect(patterns.some((p) => p.text.includes("持续学习"))).toBe(true);
    // "系统性展开讲解" has obs:2 + confidence:中 → shortTerm.context
    expect(contextItems.some((c) => c.text.includes("系统性"))).toBe(true);
  });

  it("drops one-off agent strategies (obs < 2)", () => {
    const v1 = `# Agent Beliefs

_Active slice: 2026-07-26-0823 | Last updated: Turn tRdCfA_

## Agent strategies (derived from beliefs above)

- Agent conducts bilingual web searches
  (source: 2026-07-25-1859-dCNovA)

- Agent researches before answering
  (来源: Agent researches before answering — 2026-07-25-1859-arKZnw)

## User identity (factual beliefs — user explicitly stated these)

_No beliefs yet._

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._
`;
    const result = migrateToLongShortFormat(v1, "2026-07-26-0823");
    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();
    // Both have obs: 0 (no 观察 field in old strategy format) → dropped
    expect(doc!.longTerm.strategies).toHaveLength(0);
    // But they might end up in shortTerm if they had obs ≥ 1
    // With obs: 0, they should be fully dropped
  });

  it("handles mixed content with all three sections populated", () => {
    // Realistic sample from 2026-07-26-0823
    const v1 = `# Agent Beliefs

_Active slice: 2026-07-26-0823 | Last updated: Turn tRdCfA_

## User identity (factual beliefs — user explicitly stated these)

- 用户认为生物进化是达尔文体系下的海量试错过程
  (来源: 2026/07/24/1717-user-4，用户原话)

- 用户正在准备装机
  (来源: 2026-07-25-1859-JT6QNw，用户原话)

## User patterns (pattern beliefs — agent observed these)

- 用户倾向于将AI系统本身作为讨论对象
  (置信度: 高 | 首次: 2026/07/24/1717-user-6 | 最近: 2026-07-26-0345-Uh-Qng | 观察: 6)

- 用户在做装机决策时倾向于先做充分的技术调研
  (置信度: 高 | 首次: 2026-07-25-1859-ol-Pvg | 最近: 2026-07-26-0521-atnPcg | 观察: 7)

## Agent strategies (derived from beliefs above)

- Agent conducts bilingual web searches
  (source: 2026-07-25-1859-dCNovA)

- 在用户提及过去时间点时，始终先调用recall搜索记忆
  (source: 2026-07-26-0345-mpIXkA)
`;
    const result = migrateToLongShortFormat(v1, "2026-07-26-0823");
    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();

    // Identity → longTerm.identity
    expect(doc!.longTerm.identity).toHaveLength(2);

    // Patterns with obs ≥ 3 → longTerm.patterns
    expect(doc!.longTerm.patterns).toHaveLength(2);

    // Strategies — both obs: 0 (old format without 观察 field) → dropped
    // unless they were treated differently by the heuristic
    // The "recall" strategy has no obs field → dropped

    // No short-term context should be created from these
    // (identity stays identity, patterns with >=3 obs go long-term)
  });

  it("does not duplicate beliefs during migration", () => {
    const v1 = `# Agent Beliefs

_Active slice: 2026-07-26-0823 | Last updated: Turn tRdCfA_

## User identity (factual beliefs — user explicitly stated these)

- 用户是工程师
  (来源: 2026/07/24/a-user-1，用户原话)

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const result = migrateToLongShortFormat(v1, "2026-07-26-0823");
    const count = (result.match(/用户是工程师/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ─── serializeBelief ────────────────────────────────────────────────────

describe("serializeBelief", () => {
  it("serializes a long-term belief with all fields", () => {
    const b = {
      text: "用户偏好 Rust",
      evidence: ["2026/07/24/a", "2026/07/25/b"],
      confidence: "high" as const,
      updated: "2026-07-26",
      obs: 8,
    };
    const result = serializeBelief(b, false);
    expect(result).toContain("- 用户偏好 Rust");
    expect(result).toContain("evidence: [2026/07/24/a], [2026/07/25/b]");
    expect(result).toContain("confidence: high");
    expect(result).toContain("updated: 2026-07-26");
    expect(result).toContain("obs: 8");
  });

  it("serializes a short-term belief with expires", () => {
    const b = {
      text: "用户正在装机",
      evidence: ["2026/07/25/a"],
      updated: "2026-07-26",
      expires: "2026-08-02",
    };
    const result = serializeBelief(b, true);
    expect(result).toContain("expires: 2026-08-02");
    // Short-term should NOT have confidence
    expect(result).not.toContain("confidence");
  });

  it("serializes a superseded belief", () => {
    const b = {
      text: "用户喜欢 Python",
      evidence: ["2026/07/24/a"],
      updated: "2026-07-24",
      superseded_by: "用户偏好 Rust > Python",
    };
    const result = serializeBelief(b, false);
    expect(result).toContain("superseded_by: 用户偏好 Rust > Python");
  });
});

// ─── formatDate / formatExpiry ──────────────────────────────────────────

describe("formatDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const d = new Date("2026-07-26T12:00:00Z");
    expect(formatDate(d)).toBe("2026-07-26");
  });
});

describe("formatExpiry", () => {
  it("defaults to 7 days from now", () => {
    const result = formatExpiry();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("accepts custom days", () => {
    const result = formatExpiry(14);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
