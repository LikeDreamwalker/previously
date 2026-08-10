import { describe, it, expect } from "vitest";
import { parseIdentityFromPreviously } from "@/lib/identity/user-profile";
import { newPreviouslyTemplate, serializePreviously } from "@/lib/episodic/previously-format";

describe("parseIdentityFromPreviously", () => {
  it("parses identity from a v3 previously.md (身份与背景 under 用户侧写)", () => {
    const v3 = serializePreviously({
      sliceId: "2026-08-05-1644",
      updated: "2026-08-05T16:46:18.878Z",
      profile: {
        identity: [
          {
            text: "用户名叫 LikeDreamwalker（也写作 LikeDreamWalker），可用 Dream 称呼",
            refs: ["2026/07/26/1539-esXr7w"],
            confidence: "high",
            updated: "2026-07-26",
            obs: 2,
          },
          {
            text: "用户是 AI 全栈工程师",
            refs: ["2026/08/05/1420-GM3C6g"],
            confidence: "medium",
            updated: "2026-08-05",
          },
        ],
      },
      selfModel: {},
    });

    const profile = parseIdentityFromPreviously(v3);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("LikeDreamwalker");
    expect(profile!.addressAs).toBe("Dream");
    // Body carries only belief text, not meta lines.
    expect(profile!.body).toContain("用户是 AI 全栈工程师");
    expect(profile!.body).not.toContain("refs:");
    expect(profile!.body).not.toContain("confidence:");
  });

  it("returns null when there is no identity section", () => {
    const v3 = newPreviouslyTemplate("2026-08-05-1644");
    expect(parseIdentityFromPreviously(v3)).toBeNull();
  });

  it("falls back to the legacy v2 User identity header", () => {
    const v2 = `# Previously On

## 长期记忆

### User identity

- 用户名叫 LikeDreamwalker
  evidence: [2026/07/26/1539-esXr7w] | confidence: medium | updated: 2026-07-26 | obs: 1

## 短期记忆
`;
    const profile = parseIdentityFromPreviously(v2);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("LikeDreamwalker");
    expect(profile!.body).not.toContain("evidence:");
  });

  it("parses the card Identity head: name cuts at a parenthetical, aliases extracted", () => {
    const cardContent = `# Previously On

_Active slice: 2026-08-09-0435 | Format: user card | Updated: 2026-08-09T00:00:00Z_

## Identity

- Name: LikeDreamwalker (also written LikeDreamWalker)
- Alias: Dream、阿布
- Address them as: Dream
- Pronouns: he/him

## Profile

The user is an AI engineer.
`;
    const profile = parseIdentityFromPreviously(cardContent);
    expect(profile).not.toBeNull();
    // The name must NOT swallow the parenthetical editorial note.
    expect(profile!.name).toBe("LikeDreamwalker");
    expect(profile!.addressAs).toBe("Dream");
    expect(profile!.pronouns).toBe("he/him");
    expect(profile!.aliases).toEqual(["Dream", "阿布"]);
  });

  it("parses the English Alias line form too", () => {
    const cardContent = `# Previously On

_Active slice: 2026-08-09-0435 | Format: user card | Updated: 2026-08-09T00:00:00Z_

## Identity

- Name: Alan Yuan
- Also known as: Y, Al

## Profile

x
`;
    const profile = parseIdentityFromPreviously(cardContent);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Alan Yuan");
    expect(profile!.aliases).toEqual(["Y", "Al"]);
  });
});
