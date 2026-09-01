/**
 * computeEvolutionTriggers (src/lib/evolution/triggers.ts) — the deterministic
 * trigger half of fitness scoring (v1.0 design §2.5):
 *   - a bucket's windowed net score at/below EVOLVE_TRIGGER_THRESHOLD fires it;
 *   - ANY evidence-anchored negative delta (≤ -1) THIS slice fires its bucket
 *     immediately — a -2 (explicit complaint/correction) or a -1
 *     (dissatisfaction signal / portrait-rubric pattern match) alike;
 *   - no trigger → empty list → housekeeping runs NO evolution sub-agent.
 * Pure function — no I/O, no mocks.
 */
import { describe, it, expect } from "vitest";
import {
  computeEvolutionTriggers,
  EVOLVE_TRIGGER_THRESHOLD,
  EVOLVE_WINDOW_SLICES,
} from "@/lib/evolution/triggers";
import type { FitnessEvent, FitnessStore } from "@/lib/evolution/store";

function ev(
  sliceId: string,
  bucket: FitnessEvent["bucket"],
  delta: FitnessEvent["delta"],
  ts = "2026-08-27T10:00:00Z",
): FitnessEvent {
  return { ts, sliceId, bucket, delta, evidence: "user's words" };
}

function store(events: FitnessEvent[]): FitnessStore {
  return { events, signals: [], directionRejections: [] };
}

describe("computeEvolutionTriggers", () => {
  it("fires a bucket whose windowed net score hits the threshold (-3)", () => {
    const s = store([
      ev("A", "recall", -1),
      ev("B", "recall", -1),
      ev("C", "recall", -1),
      // Noise in other buckets never counts toward recall's net.
      ev("C", "card", 1),
    ]);
    const triggers = computeEvolutionTriggers(s, []);
    expect(EVOLVE_TRIGGER_THRESHOLD).toBe(-3);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].bucket).toBe("recall");
    expect(triggers[0].reason).toContain("-3");
  });

  it("does NOT fire a bucket above the threshold (-2 net is not enough)", () => {
    const s = store([ev("A", "search", -1), ev("B", "search", -1)]);
    expect(computeEvolutionTriggers(s, [])).toEqual([]);
  });

  it("scopes the window to the newest EVOLVE_WINDOW_SLICES distinct slices", () => {
    // 10 slices of recall -1 … but the window only covers the newest 10
    // distinct slices; an 11th (oldest) slice's events fall outside.
    const events: FitnessEvent[] = [];
    for (let i = 0; i < EVOLVE_WINDOW_SLICES; i++) {
      events.push(ev(`S${String(i).padStart(2, "0")}`, "recall", -1, `2026-08-2${i}T10:00:00Z`));
    }
    // 10 × -1 in-window → fires.
    expect(
      computeEvolutionTriggers(store(events), []).map((t) => t.bucket),
    ).toContain("recall");

    // Add 2 newest slices with +1 each: the window (still 10 slices) drops the
    // two oldest -1 slices → net = (8 × -1) + (2 × +1) = -6 … still fires, but
    // with only 3 in-window negatives left it must NOT fire: rebuild so the
    // newest slices' positives pull the net above the threshold.
    const diluted: FitnessEvent[] = [
      ev("A", "recall", -1),
      ev("B", "recall", -1),
      ev("C", "recall", -1),
      // Newest slice: an approval nets the window to -2.
      ev("D", "recall", 1),
    ];
    expect(computeEvolutionTriggers(store(diluted), [])).toEqual([]);
  });

  it("a single -2 THIS slice triggers its bucket immediately, no window needed", () => {
    const triggers = computeEvolutionTriggers(store([]), [
      { bucket: "card", delta: -2, evidence: "你写错了，我说过不要用简称" },
    ]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].bucket).toBe("card");
    expect(triggers[0].reason).toContain("explicit complaint/correction");
    // Slice-neutral wording: on a boundary turn the scored slice is the one
    // that JUST CLOSED, so "this slice" would misname it.
    expect(triggers[0].reason).toContain("in the just-scored slice");
    expect(triggers[0].reason).not.toContain("this slice");
    expect(triggers[0].reason).toContain("你写错了");
  });

  it("a single evidence-anchored -1 THIS slice triggers its bucket immediately (inclusive trigger)", () => {
    const triggers = computeEvolutionTriggers(store([]), [
      { bucket: "interaction", delta: -1, evidence: "你又没回答我的问题" },
    ]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].bucket).toBe("interaction");
    expect(triggers[0].reason).toContain("dissatisfaction signal");
    expect(triggers[0].reason).toContain("in the just-scored slice");
    expect(triggers[0].reason).toContain("你又没回答我的问题");
  });

  it("an evidence-less -1 can never trigger (mirrors the store's force-zero)", () => {
    expect(
      computeEvolutionTriggers(store([]), [
        { bucket: "card", delta: -1, evidence: "" },
      ]),
    ).toEqual([]);
  });

  it("an evidence-less -2 can never trigger (mirrors the store's force-zero)", () => {
    expect(
      computeEvolutionTriggers(store([]), [
        { bucket: "recall", delta: -2, evidence: "   " },
      ]),
    ).toEqual([]);
  });

  it("no trigger → empty list (housekeeping runs NO evolution sub-agent)", () => {
    expect(computeEvolutionTriggers(store([]), [])).toEqual([]);
    expect(
      computeEvolutionTriggers(store([ev("A", "interaction", 1)]), []),
    ).toEqual([]);
  });

  it("the immediate negative wins over the window reason for the same bucket", () => {
    const s = store([ev("A", "recall", -1), ev("B", "recall", -1), ev("C", "recall", -1)]);
    const triggers = computeEvolutionTriggers(s, [
      { bucket: "recall", delta: -2, evidence: "wrong again" },
    ]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].reason).toContain("wrong again");
  });

  it("the -2 reason wins when both -2 and -1 fired for the same bucket this slice", () => {
    const triggers = computeEvolutionTriggers(store([]), [
      { bucket: "recall", delta: -1, evidence: "not quite it" },
      { bucket: "recall", delta: -2, evidence: "totally wrong" },
    ]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].reason).toContain("totally wrong");
  });
});
