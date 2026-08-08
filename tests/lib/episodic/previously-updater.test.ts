import { describe, it, expect } from "vitest";
import { applyCardUpdate } from "@/lib/episodic/previously-updater";
import {
  serializeCard,
  parseCard,
  newCardTemplate,
  type CardDocument,
} from "@/lib/episodic/previously-format";

const NOW = "2026-08-08T12:00:00.000Z";

function card(overrides: Partial<CardDocument> = {}): string {
  return serializeCard({
    sliceId: "2026-08-08-1200",
    updated: NOW,
    identity: ["Name: Alex", "Address them as: Alex"],
    profile:
      "Alex is an AI engineer who prefers concise answers and parallel decomposition of hard questions.",
    recent: [
      { text: "Evaluating a Rust migration", refs: ["2026/08/05/1420"], since: "2026-08-05" },
      { text: "Testing thinkDeep streaming", refs: ["2026/08/07/0709"], since: "2026-08-07" },
    ],
    selfModel: ["Prefer explicit low effort for simple checks."],
    ...overrides,
  });
}

describe("applyCardUpdate", () => {
  it("applies an updated card, stamps the slice id, and reports changed", () => {
    const updated = card({ profile: "Alex is an AI engineer now evaluating Rust for the product." });
    const res = applyCardUpdate(card(), updated, "2026-08-08-1200", NOW);
    expect(res.changed).toBe(true);
    const parsed = parseCard(res.content);
    expect(parsed).not.toBeNull();
    expect(parsed!.sliceId).toBe("2026-08-08-1200");
    expect(parsed!.profile).toContain("now evaluating Rust");
  });

  it("drops recent items older than 7 days", () => {
    const stale = card({
      recent: [
        { text: "Old plan", refs: [], since: "2026-07-20" }, // 19 days before NOW
        { text: "Recent plan", refs: [], since: "2026-08-07" }, // 1 day before NOW
      ],
    });
    const res = applyCardUpdate(card(), stale, "s", NOW);
    expect(res.droppedRecent).toBe(1);
    const parsed = parseCard(res.content)!;
    expect(parsed.recent.map((r) => r.text)).toEqual(["Recent plan"]);
  });

  it("caps recent at 5, newest first", () => {
    const many = card({
      recent: Array.from({ length: 7 }, (_, i) => ({
        text: `item ${i}`,
        refs: [] as string[],
        since: `2026-08-0${i + 1}`,
      })),
    });
    const res = applyCardUpdate(card(), many, "s", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.recent.length).toBeLessThanOrEqual(5);
    // Newest (highest since) kept first.
    expect(parsed.recent[0].since).toBe("2026-08-07");
  });

  it("caps the profile paragraph at the hard ceiling", () => {
    const longProfile = "x".repeat(3000);
    const res = applyCardUpdate(card(), card({ profile: longProfile }), "s", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.profile.length).toBeLessThanOrEqual(2400);
  });

  it("drops self-model lines that contradict invariants without an overrides marker", () => {
    const bad = card({
      selfModel: [
        "never use recall — it never helps",
        "always double check the timezone before answering",
      ],
    });
    const res = applyCardUpdate(card(), bad, "s", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.selfModel).not.toContain("never use recall — it never helps");
    expect(parsed.selfModel).toContain("always double check the timezone before answering");
  });

  it("keeps a self-model line that carries an explicit overrides marker", () => {
    const override = card({
      selfModel: ["never use recall unless the user asks — overrides: recall"],
    });
    const res = applyCardUpdate(card(), override, "s", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.selfModel).toContain(
      "never use recall unless the user asks — overrides: recall",
    );
  });

  it("caps self-model at 10", () => {
    const many = card({
      selfModel: Array.from({ length: 15 }, (_, i) => `lesson ${i}`),
    });
    const res = applyCardUpdate(card(), many, "s", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.selfModel.length).toBeLessThanOrEqual(10);
  });

  it("caps the identity head at 8 lines", () => {
    const many = card({
      identity: Array.from({ length: 12 }, (_, i) => `field ${i}`),
    });
    const res = applyCardUpdate(card(), many, "s", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.identity.length).toBeLessThanOrEqual(8);
  });

  it("falls back to the previous card when the updated card does not parse", () => {
    const prev = card();
    const res = applyCardUpdate(prev, "not a card at all", "s", NOW);
    expect(res.changed).toBe(false);
    expect(res.content).toBe(prev);
  });

  it("builds a card from scratch when the previous is empty", () => {
    const fresh = newCardTemplate("2026-08-08-1200");
    const updated = card({ profile: "A brand new profile." });
    const res = applyCardUpdate(fresh, updated, "2026-08-08-1200", NOW);
    const parsed = parseCard(res.content)!;
    expect(parsed.profile).toBe("A brand new profile.");
  });
});
