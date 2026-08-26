/**
 * RECALL_SKILL_DOC — the recall sub-agent skill spec the kernel ships inside
 * the chat bridge payload (skills.recall) and the client materializes as
 * skills/recall.md. These tests pin the doc's invariants so a careless edit
 * can't silently break the kernel↔client contract.
 */
import { describe, it, expect } from "vitest";
import { RECALL_SKILL_DOC } from "@/lib/bridge-skills";

describe("RECALL_SKILL_DOC", () => {
  it("keeps the {{PREVIOUSLY_CMD}} placeholder verbatim (the client fills it, never the kernel)", () => {
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}}");
    // No hardcoded absolute prefix — every command goes through the placeholder.
    expect(RECALL_SKILL_DOC).not.toMatch(/`previously /);
    // The header comment of the contract: placeholder used for every reader command.
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} timeline");
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} strands");
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} slicesummary");
  });

  it("pins the pointer-only discipline: no readslice permission for the sub-agent", () => {
    expect(RECALL_SKILL_DOC).toContain("POINTERS ONLY");
    expect(RECALL_SKILL_DOC).toContain("NO readslice permission");
    // readslice may only appear as the MAIN agent's follow-up tool, never as
    // a command the sub-agent itself runs.
    expect(RECALL_SKILL_DOC).not.toContain("{{PREVIOUSLY_CMD}} readslice <sliceId>");
  });

  it("prescribes the timeline → window → strand → report exploration order", () => {
    const timeline = RECALL_SKILL_DOC.indexOf("1. Read the global timeline index");
    const window = RECALL_SKILL_DOC.indexOf("2. If the query is about a time period");
    const strand = RECALL_SKILL_DOC.indexOf("3. If a topic seems relevant");
    const report = RECALL_SKILL_DOC.indexOf("4. When you have enough information");
    expect(timeline).toBeGreaterThan(-1);
    expect(window).toBeGreaterThan(timeline);
    expect(strand).toBeGreaterThan(window);
    expect(report).toBeGreaterThan(strand);
    expect(RECALL_SKILL_DOC).toContain("aim for 2-4 steps");
  });

  it("never treats the current slice as a hit and accepts an empty result as terminal", () => {
    expect(RECALL_SKILL_DOC).toContain("ONGOING conversation, NOT a past memory");
    expect(RECALL_SKILL_DOC).toContain("never return it as a hit or recommended read");
    expect(RECALL_SKILL_DOC).toContain('an honest "no hits" is a terminal answer');
  });

  it("pins the report contract fields (recallReport shape, text edition)", () => {
    expect(RECALL_SKILL_DOC).toContain("REPORT CONTRACT");
    expect(RECALL_SKILL_DOC).toContain("hits:");
    expect(RECALL_SKILL_DOC).toContain("slice_id");
    expect(RECALL_SKILL_DOC).toContain("relevance (0-1)");
    expect(RECALL_SKILL_DOC).toContain("confidence");
    expect(RECALL_SKILL_DOC).toContain("reasoning");
    expect(RECALL_SKILL_DOC).toContain("recommended_reads:");
    expect(RECALL_SKILL_DOC).toContain("at most 5");
    expect(RECALL_SKILL_DOC).toContain("priority (high|medium|low)");
  });
});
