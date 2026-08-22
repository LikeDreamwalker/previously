import { describe, it, expect } from "vitest";
import {
  assembleSystemPrompt,
  buildOverdueBlock,
} from "@/app/api/chat/turn-workflow";

const IDENTITY = "SOUL + DIRECTIVES";
const PREVIOUSLY = "# Previously card";
const STATIC_RULES =
  "The above is the current profile and operating model — distilled hypotheses";
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
  it("orders layers by stability: L0 identity → L1 card → L2 rules → L3 slice head → L4 timeline → L5 strands/demo", () => {
    const s = build();
    expect(s.indexOf(IDENTITY)).toBe(0); // L0 leads the prompt
    expect(s.indexOf(PREVIOUSLY)).toBeGreaterThan(s.indexOf(IDENTITY)); // L1
    expect(s.indexOf(STATIC_RULES)).toBeGreaterThan(s.indexOf(PREVIOUSLY)); // L2
    expect(s.indexOf(SLICE_HEAD)).toBeGreaterThan(s.indexOf(STATIC_RULES)); // L3
    expect(s.indexOf(TIMELINE)).toBeGreaterThan(s.indexOf(SLICE_HEAD)); // L4
    expect(s.indexOf(STRANDS)).toBeGreaterThan(s.indexOf(TIMELINE)); // L5
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
      "## What I know about the user (inference model — 2026-08-09)",
    );
  });

  it("places the overdue-Horizon block (L2b) between the static rules and the slice-head block", () => {
    const overdue = "## Overdue commitments\n…past their by date…";
    const s = build({ overdueBlock: overdue });
    expect(s).toContain("## Overdue commitments");
    expect(s.indexOf(overdue)).toBeGreaterThan(s.indexOf(STATIC_RULES));
    expect(s.indexOf(overdue)).toBeLessThan(s.indexOf(SLICE_HEAD));
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
