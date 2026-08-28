/**
 * RECALL_SKILL_DOC — the recall sub-agent skill spec the kernel ships inside
 * the chat bridge payload (skills.recall) and the client materializes as
 * skills/recall.md. These tests pin the doc's invariants so a careless edit
 * can't silently break the kernel↔client contract.
 *
 * v1.0 Phase A: the doc now mirrors the kernel recall COLLEAGUE contract
 * (src/lib/episodic/flash/recall.ts) — the sub-agent reads slices ITSELF with
 * the reader commands and answers with verbatim-quote references, instead of
 * the v0.9 pointer-only hits list.
 */
import { describe, it, expect } from "vitest";
import { RECALL_SKILL_DOC } from "@/lib/bridge-skills";

describe("RECALL_SKILL_DOC", () => {
  it("keeps the {{PREVIOUSLY_CMD}} placeholder verbatim (the client fills it, never the kernel)", () => {
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}}");
    // No hardcoded absolute prefix — every command goes through the placeholder.
    expect(RECALL_SKILL_DOC).not.toMatch(/`previously /);
    // The placeholder prefixes every reader command, including full reads.
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} timeline");
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} strands");
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} slicesummary");
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} readslice");
  });

  it("is the Phase-A colleague contract: the sub-agent reads slices ITSELF (no pointer-only discipline)", () => {
    expect(RECALL_SKILL_DOC).toContain("recall colleague");
    expect(RECALL_SKILL_DOC).toContain("read slice CONTENT");
    // readslice is now a FIRST-CLASS reader command of the sub-agent…
    expect(RECALL_SKILL_DOC).toContain("{{PREVIOUSLY_CMD}} readslice <sliceId> [range]");
    // …with the full-read budget from the kernel contract.
    expect(RECALL_SKILL_DOC).toContain("at most 5 slices in full");
    // The old pointer-only prohibition is gone.
    expect(RECALL_SKILL_DOC).not.toContain("POINTERS ONLY");
    expect(RECALL_SKILL_DOC).not.toContain("NO readslice permission");
  });

  it("mirrors the kernel readSlice range schema in the readslice flags", () => {
    expect(RECALL_SKILL_DOC).toContain("--last N");
    expect(RECALL_SKILL_DOC).toContain("--after <ISO 8601>");
    expect(RECALL_SKILL_DOC).toContain("--turns i,j,k");
    expect(RECALL_SKILL_DOC).toContain("--search kw1,kw2 [--context N]");
    expect(RECALL_SKILL_DOC).toContain("--lines A-B");
  });

  it("prescribes the time-anchor → strands → broaden → verify exploration order", () => {
    const anchor = RECALL_SKILL_DOC.indexOf("1. TIME ANCHOR FIRST");
    const strands = RECALL_SKILL_DOC.indexOf("2. TRACE CLUES");
    const broaden = RECALL_SKILL_DOC.indexOf("3. BROADEN LAST");
    const verify = RECALL_SKILL_DOC.indexOf("4. VERIFY BEFORE ANSWERING");
    expect(anchor).toBeGreaterThan(-1);
    expect(strands).toBeGreaterThan(anchor);
    expect(broaden).toBeGreaterThan(strands);
    expect(verify).toBeGreaterThan(broaden);
  });

  it("pins the colleague relationship and the current-slice exclusion", () => {
    // The caller is the main agent; the user is always a third party.
    expect(RECALL_SKILL_DOC).toContain("your colleague, not the user");
    expect(RECALL_SKILL_DOC).toContain("third person");
    expect(RECALL_SKILL_DOC).toContain("ONGOING conversation, NOT a past memory");
    expect(RECALL_SKILL_DOC).toContain("never cite it as evidence");
  });

  it("pins the evidence-anchored report contract (answer / references / searched / confidence)", () => {
    expect(RECALL_SKILL_DOC).toContain("REPORT CONTRACT");
    expect(RECALL_SKILL_DOC).toContain("answer:");
    expect(RECALL_SKILL_DOC).toContain("references:");
    expect(RECALL_SKILL_DOC).toContain("VERBATIM quote");
    expect(RECALL_SKILL_DOC).toContain("searched:");
    expect(RECALL_SKILL_DOC).toContain("confidence:");
    // An honest "no such memory" is a terminal answer, not a failure.
    expect(RECALL_SKILL_DOC).toContain("is a VALID and important answer");
  });
});
