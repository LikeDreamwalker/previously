import { describe, it, expect } from "vitest";
import { diffCardLines, summarizeCardChanges } from "@/lib/episodic/card-diff";
import { serializeCard } from "@/lib/episodic/previously-format";

describe("diffCardLines", () => {
  it("returns no mutations for identical cards", () => {
    expect(diffCardLines("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("reports lines only in the new revision as added", () => {
    const out = diffCardLines("a\nb", "a\nb\nc");
    expect(out).toEqual([{ type: "added", text: "c" }]);
  });

  it("reports lines only in the old revision as removed", () => {
    const out = diffCardLines("a\nb\nc", "a\nb");
    expect(out).toEqual([{ type: "removed", text: "c" }]);
  });

  it("reports an edited line as removed + added", () => {
    const out = diffCardLines("a\nold\nb", "a\nnew\nb");
    expect(out).toEqual([
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
    ]);
  });

  it("ignores blank lines and surrounding whitespace", () => {
    const out = diffCardLines("a\n\n  b  \n", "a\nb\n\n");
    expect(out).toEqual([]);
  });

  it("collapses duplicate lines", () => {
    const out = diffCardLines("x", "x\ny\ny\ny");
    expect(out).toEqual([{ type: "added", text: "y" }]);
  });

  it("caps each side so a full rewrite stays bounded", () => {
    const before = Array.from({ length: 30 }, (_, i) => `old-${i}`).join("\n");
    const after = Array.from({ length: 30 }, (_, i) => `new-${i}`).join("\n");
    const out = diffCardLines(before, after);
    expect(out.filter((m) => m.type === "removed")).toHaveLength(12);
    expect(out.filter((m) => m.type === "added")).toHaveLength(12);
  });

  it("ignores the stamp and section-heading scaffold lines", () => {
    const before = "# Previously On\n_Active slice: 2026-08-14-1000 | Format: user card | Updated: 2026-08-14_\n## Profile\nsame";
    const after = "# Previously On\n_Active slice: 2026-08-14-1100 | Format: user card | Updated: 2026-08-15_\n## Profile\nsame";
    expect(diffCardLines(before, after)).toEqual([]);
  });
});

describe("summarizeCardChanges", () => {
  const card = (over: Partial<Parameters<typeof serializeCard>[0]>) =>
    serializeCard({
      sliceId: "2026-08-14-1000",
      updated: "2026-08-14",
      identity: ["Name: Bob"],
      past: { profile: "Bob is a developer.", anchors: [] },
      now: [{ text: "Exploring timeline UI", refs: [], since: "2026-08-13" }],
      horizon: [],
      selfModel: ["Always cite refs"],
      ...over,
    });

  it("counts brand-new entries as added", () => {
    const before = card({});
    const after = card({ selfModel: ["Always cite refs", "Prefer terse answers"] });
    expect(summarizeCardChanges(before, after)).toEqual({
      added: 1,
      reinforced: 0,
      demoted: 0,
      removed: 0,
      superseded: 0,
    });
  });

  it("counts a rewritten entry as superseded, not add + remove", () => {
    const before = card({});
    const after = card({ now: [{ text: "Exploring the timeline wheel UI", refs: [], since: "2026-08-13" }] });
    const sum = summarizeCardChanges(before, after);
    expect(sum.superseded).toBe(1);
    expect(sum.added).toBe(0);
    expect(sum.removed).toBe(0);
  });

  it("counts an in-place Past profile rewrite as reinforced", () => {
    const before = card({});
    const after = card({ past: { profile: "Bob is a senior developer who values directness.", anchors: [] } });
    expect(summarizeCardChanges(before, after).reinforced).toBe(1);
  });

  it("reports expired Now items as demoted, excluded from removed", () => {
    const before = card({
      now: [
        { text: "Exploring timeline UI", refs: [], since: "2026-08-13" },
        { text: "Old stale item", refs: [], since: "2026-08-01" },
      ],
    });
    // The updater already dropped the stale item from the applied card.
    const after = card({});
    const sum = summarizeCardChanges(before, after, 1);
    expect(sum.demoted).toBe(1);
    expect(sum.removed).toBe(0);
  });

  it("falls back to line-diff counts for non-card content", () => {
    const sum = summarizeCardChanges("alpha\nbeta", "beta\ngamma");
    expect(sum).toEqual({
      added: 1,
      reinforced: 0,
      demoted: 0,
      removed: 1,
      superseded: 0,
    });
  });
});
