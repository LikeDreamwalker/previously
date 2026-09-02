import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  assembleSystemPrompt,
  buildOverdueBlock,
  BRIDGE_NOTICE,
  buildBridgeTimeLine,
  appendBridgeTimeSuffix,
} from "@/app/api/chat/turn-workflow";
import { CHARTER_MD } from "@/lib/identity/agent-prompt.generated";

const IDENTITY = "THE CHARTER";
const PREVIOUSLY = "# Previously card";
const DIRECTION = "## Direction — who the user is (evolved portrait)";
const SLICE_HEAD =
  "## This slice — snapshot at its start\n- Slice started: 02 Aug 2026, 14:32 (Asia/Shanghai, UTC+8)";
const TIMELINE = "## Timeline (recent)\n- **2026-08-01-1115** (08-01 Fri) 回顾";
const STRANDS = "## Memory topics\n\nKnown topics: rust";
const DEMO = "## Demo mode (read-only)";

type Opts = Parameters<typeof assembleSystemPrompt>[0];

function build(overrides: Partial<Opts> = {}): string {
  return assembleSystemPrompt({
    identityPrompt: IDENTITY,
    previouslyContent: PREVIOUSLY,
    sliceHeadBlock: SLICE_HEAD,
    timelineBrief: TIMELINE,
    strandsBlock: STRANDS,
    demoNotice: DEMO,
    overdueBlock: "",
    dateAnchor: "2026-08-09",
    ...overrides,
  });
}

describe("assembleSystemPrompt (v0.9 slice-level freeze)", () => {
  it("orders layers by stability: L0 charter → L1b direction → L1 card → L3 slice head → L4 timeline → L5 strands/demo", () => {
    const s = build({ directionBlock: DIRECTION });
    expect(s.indexOf(IDENTITY)).toBe(0); // L0 leads the prompt
    // WHO (the user model) frames the reading of WHAT (the card).
    expect(s.indexOf(DIRECTION)).toBeGreaterThan(s.indexOf(IDENTITY));
    expect(s.indexOf(PREVIOUSLY)).toBeGreaterThan(s.indexOf(DIRECTION));
    expect(s.indexOf(SLICE_HEAD)).toBeGreaterThan(s.indexOf(PREVIOUSLY));
    expect(s.indexOf(TIMELINE)).toBeGreaterThan(s.indexOf(SLICE_HEAD));
    expect(s.indexOf(STRANDS)).toBeGreaterThan(s.indexOf(TIMELINE));
    expect(s.indexOf(DEMO)).toBeGreaterThan(s.indexOf(STRANDS)); // L5 tail
  });

  it("CORE REGRESSION: byte-identical when assembled twice within one slice (prefix cache)", () => {
    // Every input is anchored to the slice head, so two turns of the same
    // slice assemble the exact same bytes. There is deliberately NO per-turn
    // parameter left on Opts (Sent:/intent/emotional/semantic links were
    // retired in v0.9) — this test pins the freeze contract.
    const turn1 = build();
    const turn2 = build();
    expect(turn2).toBe(turn1);
    expect(turn2.length).toBeGreaterThan(0);
  });

  it("has no evolution-notice parameter — the birth evolution rides inside the frozen slice-head block", () => {
    const s = build({
      sliceHeadBlock: `${SLICE_HEAD}\n- The user card was updated just as this slice began: sharpened the profile.`,
    });
    expect(s).toContain("The user card was updated just as this slice began");
    // …and it lives in L3, before the timeline brief.
    expect(s.indexOf("user card was updated")).toBeLessThan(s.indexOf(TIMELINE));
  });

  it("omits empty optional blocks", () => {
    const s = build({ timelineBrief: "", strandsBlock: "", demoNotice: "" });
    expect(s).not.toContain("Memory topics");
    expect(s).not.toContain("Demo mode");
    expect(s).not.toContain("Timeline (recent)");
  });

  it("renders the card-freshness header with the slice-head date anchor", () => {
    expect(build()).toContain(
      "## What I know about the user — the living recap (2026-08-09)",
    );
  });

  it("places the overdue-Horizon block (L2b) between the card and the slice-head block", () => {
    const overdue = "## Overdue commitments\n…past their by date…";
    const s = build({ overdueBlock: overdue });
    expect(s).toContain("## Overdue commitments");
    expect(s.indexOf(overdue)).toBeGreaterThan(s.indexOf(PREVIOUSLY));
    expect(s.indexOf(overdue)).toBeLessThan(s.indexOf(SLICE_HEAD));
  });

  it("places the direction block before the card — absent by default", () => {
    const s = build({ directionBlock: DIRECTION });
    expect(s).toContain(DIRECTION);
    expect(s.indexOf(DIRECTION)).toBeGreaterThan(s.indexOf(IDENTITY));
    expect(s.indexOf(DIRECTION)).toBeLessThan(s.indexOf(PREVIOUSLY));
    // Default: the layer is omitted entirely (template / legacy direction docs).
    expect(build()).not.toContain("Direction — who the user is");
  });

  it("carries NO inline static-rules layer — the two documents' contract lives in the charter (L0), stated once", () => {
    const s = build({ directionBlock: DIRECTION });
    expect(s).not.toContain("GROUNDING RULE");
    expect(s).not.toContain("The recap above holds WHAT");
  });
});

describe("buildOverdueBlock (frozen derivation from raw card + slice-head date)", () => {
  // A minimal v5 card (isCardFormat requires ## Identity + ## Past) with one
  // overdue and one future Horizon item.
  const CARD = [
    "## Identity",
    "",
    "Name: Alan",
    "",
    "## Past",
    "",
    "A profile paragraph.",
    "",
    "## Horizon",
    "",
    "- 周五面试等 HR 回复 — by: 2026-08-05 — refs: [2026/08/01/0900]",
    "- 下个月的体检 — by: 2026-09-10 — refs: [2026/08/01/0900]",
  ].join("\n");

  it("lists only items whose by date is before the slice-head date (zh)", () => {
    const s = buildOverdueBlock(CARD, "2026-08-09", "zh");
    expect(s).toContain("## 逾期承诺");
    expect(s).toContain("周五面试等 HR 回复");
    expect(s).not.toContain("体检"); // future item stays out
  });

  it("renders English when locale is not zh", () => {
    const s = buildOverdueBlock(CARD, "2026-08-09", "en");
    expect(s).toContain("## Overdue commitments");
    expect(s).toContain('"周五面试等 HR 回复" (by 2026-08-05)');
  });

  it("is empty when nothing is overdue, the card is empty, or the card is unparseable", () => {
    expect(buildOverdueBlock(CARD, "2026-08-01", "zh")).toBe(""); // neither past due
    expect(buildOverdueBlock("", "2026-08-09", "zh")).toBe("");
    expect(buildOverdueBlock("free-form legacy text", "2026-08-09")).toBe("");
  });

  it("is byte-stable for repeated assembly within one slice (frozen inputs)", () => {
    expect(buildOverdueBlock(CARD, "2026-08-09", "zh")).toBe(
      buildOverdueBlock(CARD, "2026-08-09", "zh"),
    );
  });
});

// ─── Bridge mode: notice + fresh-time injection ────────────────────────────

describe("bridgeNotice (subscription bridge mode)", () => {
  it("renders as the L5b tail when injected (bridge sdk)", () => {
    const s = build({ bridgeNotice: BRIDGE_NOTICE });
    expect(s).toContain("## Subscription bridge mode");
    expect(s.indexOf(BRIDGE_NOTICE)).toBeGreaterThan(s.indexOf(DEMO));
  });

  it("is absent for non-bridge turns (no bridgeNotice option)", () => {
    expect(build()).not.toContain("Subscription bridge mode");
  });

  it("keeps the slice-freeze intact: byte-identical with the notice, and the notice carries no per-turn data", () => {
    expect(build({ bridgeNotice: BRIDGE_NOTICE })).toBe(
      build({ bridgeNotice: BRIDGE_NOTICE }),
    );
    // The fresh time NEVER enters the system prompt — it rides the last user
    // message instead (see buildBridgeTimeLine below).
    expect(BRIDGE_NOTICE).not.toContain("[Current time:");
  });

  it("pins the notice contract: no `previously recall`, recall via skills/recall.md sub-agent, verbatim output", () => {
    // The `previously recall` command no longer exists on the client.
    expect(BRIDGE_NOTICE).not.toContain("previously recall");
    // Memory access runs through the workspace reader commands…
    for (const cmd of ["timeline", "strands", "slicesummary", "readslice", "card", "agentlog"]) {
      expect(BRIDGE_NOTICE).toContain(`previously ${cmd}`);
    }
    // …and past-looking questions go through the recall skill sub-agent,
    // pointers only.
    expect(BRIDGE_NOTICE).toContain("skills/recall.md");
    expect(BRIDGE_NOTICE).toContain("POINTERS");
    // The countermand + output contract survive the rewrite.
    expect(BRIDGE_NOTICE).toContain("thinkDeep guidance elsewhere in this prompt does NOT apply");
    expect(BRIDGE_NOTICE).toContain("rendered verbatim");
  });
});

describe("buildBridgeTimeLine (bridge-mode fresh clock read)", () => {
  const OPTS = {
    sliceId: "2026-08-26-1530",
    maxSliceMinutes: 30,
    timezone: "Asia/Shanghai",
    nowIso: "2026-08-26T15:42:00.000Z",
  };

  it("renders local time / UTC and the slice's remaining minutes (parsed from the slice id)", () => {
    const line = buildBridgeTimeLine(OPTS);
    expect(line.startsWith("\n\n[Current time: ")).toBe(true);
    expect(line.endsWith("]")).toBe(true);
    expect(line).toContain("26 Aug 2026, 23:42");
    expect(line).toContain("Asia/Shanghai");
    expect(line).toContain("/ 2026-08-26T15:42:00.000Z");
    expect(line).toContain("slice closes in ~18 min");
  });

  it("sends only the time part when the slice id is unparseable", () => {
    const line = buildBridgeTimeLine({ ...OPTS, sliceId: "not-a-slice" });
    expect(line).toContain("[Current time:");
    expect(line).not.toContain("slice closes");
  });

  it("omits the slice part once the slice is past its cap", () => {
    const line = buildBridgeTimeLine({
      ...OPTS,
      nowIso: "2026-08-26T16:05:00.000Z",
    });
    expect(line).not.toContain("slice closes");
  });

  it("names the idle-gap close alongside the cap when idleGapMinutes is given (v0.9.1 — the cap alone would promise time the idle gap won't grant)", () => {
    const line = buildBridgeTimeLine({ ...OPTS, idleGapMinutes: 15 });
    expect(line).toContain("slice closes in ~18 min at the latest, or after ~15 min of silence");
  });

  it("keeps the cap-only wording when idleGapMinutes is absent (backwards compatible)", () => {
    const line = buildBridgeTimeLine(OPTS);
    expect(line).toContain("slice closes in ~18 min");
    expect(line).not.toContain("silence");
  });
});

describe("appendBridgeTimeSuffix (outbound-only tail injection)", () => {
  const LINE = "\n\n[Current time: x]";

  it("appends to the LAST user message's string content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "second" },
    ];
    const out = appendBridgeTimeSuffix(msgs, LINE);
    expect(out[2]).toEqual({ role: "user", content: "second" + LINE });
    expect(out[0]).toEqual({ role: "user", content: "first" });
    // Outbound copy only — the input is untouched.
    expect(msgs[2]).toEqual({ role: "user", content: "second" });
  });

  it("appends a text part to array content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const out = appendBridgeTimeSuffix(msgs, LINE);
    const content = (out[0] as { content: Array<{ type: string; text?: string }> })
      .content;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "text", text: LINE });
  });

  it("is a no-op when the window has no user message", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: "hi" }];
    expect(appendBridgeTimeSuffix(msgs, LINE)).toEqual(msgs);
  });
});

describe("the grounding rule (never answer the past from a compression)", () => {
  it("lives in the CHARTER (L0, highest priority), stated exactly once, with the hard mandate and the in-conversation exemptions", () => {
    expect(CHARTER_MD).toContain("THE GROUNDING RULE");
    // The hard mandate: even when a compressed document appears to already
    // contain the answer, past specifics come ONLY from original slice text.
    expect(CHARTER_MD).toContain("you may NOT answer past specifics from it");
    expect(CHARTER_MD).toContain("recall or read FIRST, then answer");
    // …with the exemptions: current slice, this conversation, and original
    // material already recalled/read into it.
    expect(CHARTER_MD).toContain("Three exemptions");
    // Stated exactly once — no second copy may drift from it.
    expect(CHARTER_MD.match(/GROUNDING RULE/g)).toHaveLength(1);
    // The charter declares its own supremacy over every other layer.
    expect(CHARTER_MD).toContain("NOTHING outranks it");
  });
});
