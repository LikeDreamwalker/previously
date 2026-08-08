import { describe, it, expect } from "vitest";
import {
  serializePreviously,
  parsePreviously,
  newPreviouslyTemplate,
  validatePreviouslyFormat,
  migrateToV3,
  isV2Format,
  isV3Format,
  serializeCard,
  parseCard,
  newCardTemplate,
  migrateV3ToCard,
  isCardFormat,
  type PreviouslyDocument,
  type PreviouslyBelief,
  type CardDocument,
} from "@/lib/episodic/previously-format";

// ─── Helpers ────────────────────────────────────────────────────────────

function belief(text: string, overrides: Partial<PreviouslyBelief> = {}): PreviouslyBelief {
  return {
    text,
    refs: ["2026/07/26/1539-esXr7w"],
    updated: "2026-07-26",
    confidence: "medium",
    obs: 1,
    ...overrides,
  };
}

function docWithIdentity(text: string): string {
  const doc: PreviouslyDocument = {
    sliceId: "2026-07-26-1226",
    updated: "2026-07-26T12:00:00Z",
    profile: { identity: [belief(text)] },
    selfModel: {},
  };
  return serializePreviously(doc);
}

// ─── newPreviouslyTemplate ───────────────────────────────────────────────

describe("newPreviouslyTemplate", () => {
  it("produces a v3 two-section document that parses back to an empty doc", () => {
    const content = newPreviouslyTemplate("2026-07-26-1226");
    expect(content).toContain("## User profile");
    expect(content).toContain("## Self-model");
    expect(content).toContain("_Active slice: 2026-07-26-1226");

    const doc = parsePreviously(content);
    expect(doc).not.toBeNull();
    expect(doc!.sliceId).toBe("2026-07-26-1226");
    expect(Object.keys(doc!.profile)).toHaveLength(0);
    expect(Object.keys(doc!.selfModel)).toHaveLength(0);
  });

  it("validates as a valid document", () => {
    const result = validatePreviouslyFormat(newPreviouslyTemplate("2026-07-26-1226"));
    expect(result.valid).toBe(true);
  });
});

// ─── serialize / parse round-trip ────────────────────────────────────────

describe("serializePreviously / parsePreviously", () => {
  it("round-trips a populated document across both sections", () => {
    const doc: PreviouslyDocument = {
      sliceId: "2026-08-05-1644",
      updated: "2026-08-05T16:46:18.878Z",
      profile: {
        identity: [belief("用户是 AI 全栈工程师", { confidence: "high", obs: 2 })],
        current_state: [belief("正在评估迁移到 Rust", { expires: "2026-08-19" })],
      },
      selfModel: {
        tool_discipline: [belief("涉具体 API 先 webSearch 验证", { refs: ["agent.md 2026/08/05/1403"] })],
        corrections: [belief("用户纠正过：别给废话开场白", { refuted_by: "用户明确要求直接回答" })],
      },
    };

    const content = serializePreviously(doc);
    const parsed = parsePreviously(content);

    expect(parsed).not.toBeNull();
    expect(parsed!.sliceId).toBe("2026-08-05-1644");

    expect(parsed!.profile.identity?.[0].text).toBe("用户是 AI 全栈工程师");
    expect(parsed!.profile.identity?.[0].confidence).toBe("high");
    expect(parsed!.profile.identity?.[0].obs).toBe(2);

    expect(parsed!.profile.current_state?.[0].expires).toBe("2026-08-19");

    expect(parsed!.selfModel.tool_discipline?.[0].text).toBe("涉具体 API 先 webSearch 验证");
    expect(parsed!.selfModel.tool_discipline?.[0].refs).toContain("agent.md 2026/08/05/1403");

    expect(parsed!.selfModel.corrections?.[0].refuted_by).toBe("用户明确要求直接回答");
  });

  it("serializes refs as bracketed pointers", () => {
    const content = docWithIdentity("用户喜欢看电影");
    expect(content).toContain("refs: [2026/07/26/1539-esXr7w]");
    // No legacy "evidence:" key on output
    expect(content).not.toContain("evidence:");
  });

  it("omits empty subsections", () => {
    const content = serializePreviously({
      sliceId: "2026-07-26-1226",
      updated: "2026-07-26T12:00:00Z",
      profile: { identity: [belief("一条")] },
      selfModel: {},
    });
    // Only the populated dimension header appears.
    expect(content).toContain("### Identity & background");
    expect(content).not.toContain("### Communication preferences");
    expect(content).not.toContain("### Tool discipline");
  });
});

// ─── validatePreviouslyFormat ────────────────────────────────────────────

describe("validatePreviouslyFormat", () => {
  it("accepts a document where every entry carries refs", () => {
    const result = validatePreviouslyFormat(docWithIdentity("用户喜欢看电影"));
    expect(result.valid).toBe(true);
  });

  it("flags a missing section", () => {
    const result = validatePreviouslyFormat("## Only one section\n\n- no structure");
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain("User profile");
  });

  it("flags an entry without refs", () => {
    const content = serializePreviously({
      sliceId: "2026-07-26-1226",
      updated: "2026-07-26T12:00:00Z",
      profile: { identity: [{ text: "没有证据的推断", refs: [], updated: "2026-07-26" }] },
      selfModel: {},
    });
    const result = validatePreviouslyFormat(content);
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain("missing refs");
  });
});

// ─── Legacy migration ────────────────────────────────────────────────────

const V2_CONTENT = `# Previously On

_Active slice: 2026-08-05-1644 | Updated: 2026-08-05T16:46:18.878Z_

## 长期记忆

### User identity

- 用户是 AI 全栈工程师
  evidence: [2026/07/26/1539-esXr7w] | confidence: medium | updated: 2026-07-26 | obs: 1

### User patterns

- 用户偏好将复杂问题拆解为独立子问题
  evidence: [2026/08/05/1420-GM3C6g] | confidence: medium | updated: 2026-08-05 | obs: 1

### Agent strategies

- 回答时主动融入理论框架
  evidence: [2026/07/26/1539-GZtv2Q] | confidence: medium | updated: 2026-07-27 | obs: 1

## 短期记忆

### Current context

- User is evaluating migrating to Rust
  evidence: [2026/08/05/1420-MlBkBA] | updated: 2026-08-05 | obs: 1 | expires: 2026-08-12
`;

const V1_CONTENT = `# Previously On

## User identity

- 用户是 Rust 工程师
  evidence: [2026/07/24/1717-user-4] | confidence: medium | updated: 2026-07-24 | obs: 2

## User patterns

- 做技术决策前会充分调研
  evidence: [2026/07/25/1226-user-1] | confidence: medium | updated: 2026-07-25 | obs: 3

## Agent strategies

- 回答 Rust 问题时直接给代码方案
  evidence: [2026/07/24/1717-user-5] | confidence: medium | updated: 2026-07-24 | obs: 2
`;

describe("migrateToV3", () => {
  it("detects v2 and v3 formats", () => {
    expect(isV2Format(V2_CONTENT)).toBe(true);
    expect(isV3Format(V2_CONTENT)).toBe(false);
    expect(isV3Format(newPreviouslyTemplate("x"))).toBe(true);
  });

  it("maps v2 sections onto the v3 structure", () => {
    const result = migrateToV3(V2_CONTENT, "2026-08-05-1644");
    expect(isV3Format(result)).toBe(true);

    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();

    // identity → profile.identity
    expect(doc!.profile.identity?.[0].text).toBe("用户是 AI 全栈工程师");
    expect(doc!.profile.identity?.[0].refs).toContain("2026/07/26/1539-esXr7w");

    // patterns → profile.work_style
    expect(doc!.profile.work_style?.[0].text).toContain("复杂问题拆解");

    // strategies → selfModel.tool_discipline
    expect(doc!.selfModel.tool_discipline?.[0].text).toContain("理论框架");

    // context → profile.current_state, keeps expires
    expect(doc!.profile.current_state?.[0].text).toContain("migrating to Rust");
    expect(doc!.profile.current_state?.[0].expires).toBe("2026-08-12");
  });

  it("maps v1 flat sections onto the v3 structure", () => {
    const result = migrateToV3(V1_CONTENT, "2026-07-24-0913");
    const doc = parsePreviously(result);
    expect(doc).not.toBeNull();
    expect(doc!.profile.identity?.[0].text).toBe("用户是 Rust 工程师");
    expect(doc!.profile.work_style?.[0].text).toContain("充分调研");
    expect(doc!.selfModel.tool_discipline?.[0].text).toContain("直接给代码");
  });

  it("returns already-v3 content unchanged", () => {
    const v3 = newPreviouslyTemplate("2026-08-05-1644");
    expect(migrateToV3(v3)).toBe(v3);
  });
});

// ─── User card (v4) ─────────────────────────────────────────────────────

describe("user card format (v4)", () => {
  function card(overrides: Partial<CardDocument> = {}): CardDocument {
    return {
      sliceId: "2026-08-08-1200",
      updated: "2026-08-08T12:00:00.000Z",
      identity: ["Name: Alex", "Address them as: Alex"],
      profile: "Alex is an AI engineer who prefers concise answers.",
      recent: [
        { text: "Evaluating a Rust migration", refs: ["2026/08/05/1420"], since: "2026-08-05" },
      ],
      selfModel: ["Prefer explicit low effort for simple checks."],
      ...overrides,
    };
  }

  it("round-trips a populated card through serializeCard / parseCard", () => {
    const serialized = serializeCard(card());
    expect(isCardFormat(serialized)).toBe(true);
    const parsed = parseCard(serialized)!;
    expect(parsed.sliceId).toBe("2026-08-08-1200");
    expect(parsed.identity).toEqual(["Name: Alex", "Address them as: Alex"]);
    expect(parsed.profile).toContain("concise answers");
    expect(parsed.recent[0]).toEqual({
      text: "Evaluating a Rust migration",
      refs: ["2026/08/05/1420"],
      since: "2026-08-05",
    });
    expect(parsed.selfModel).toEqual(["Prefer explicit low effort for simple checks."]);
  });

  it("produces an empty template that parses back", () => {
    const tpl = newCardTemplate("2026-08-08-1200");
    expect(isCardFormat(tpl)).toBe(true);
    const parsed = parseCard(tpl)!;
    expect(parsed.identity).toEqual([]);
    expect(parsed.profile).toBe("");
    expect(parsed.recent).toEqual([]);
    expect(parsed.selfModel).toEqual([]);
  });

  it("is distinct from v3 — migrateToV3 never downgrades a card", () => {
    const serialized = serializeCard(card());
    expect(isV3Format(serialized)).toBe(false);
    expect(migrateToV3(serialized)).toBe(serialized);
  });

  it("migrates a v3 document into the card structure", () => {
    const v3 = docWithIdentity("User is named Alex, an AI engineer");
    const migrated = migrateV3ToCard(v3, "2026-08-08-1200");
    expect(isCardFormat(migrated)).toBe(true);
    const parsed = parseCard(migrated)!;
    // identity bullet folded into the Identity head
    expect(parsed.identity.join(" ")).toContain("named Alex");
  });
});
