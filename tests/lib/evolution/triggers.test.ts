/**
 * computeEvolutionTriggers (src/lib/evolution/triggers.ts) — the deterministic
 * trigger half of fitness scoring (v1.0 design §2.5, generation semantics
 * v0.9.2):
 *   - a bucket fires when its CURRENT-GENERATION net score reaches
 *     EVOLVE_TRIGGER_THRESHOLD (-5) — one number, no semantic fast paths;
 *   - -2 explicit complaints simply weigh double; +1 approvals offset;
 *   - every event in the store is current-generation by construction (a
 *     successful evolution run settles the store via resetFitnessGeneration);
 *   - no trigger → empty list → housekeeping runs NO evolution sub-agent.
 * Pure function — no I/O, no mocks.
 */
import { describe, it, expect } from "vitest";
import {
  computeEvolutionTriggers,
  EVOLVE_TRIGGER_THRESHOLD,
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
  it("fires a bucket whose generation net reaches the threshold (-5)", () => {
    expect(EVOLVE_TRIGGER_THRESHOLD).toBe(-5);
    const s = store([
      ev("A", "recall", -1),
      ev("B", "recall", -1),
      ev("C", "recall", -1),
      ev("D", "recall", -1),
      ev("E", "recall", -1),
      // Noise in other buckets never counts toward recall's net.
      ev("E", "card", 1),
    ]);
    const triggers = computeEvolutionTriggers(s);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].bucket).toBe("recall");
    expect(triggers[0].reason).toContain("-5");
  });

  it("does NOT fire below the threshold (-4 is not enough — noise never fires)", () => {
    const s = store([
      ev("A", "search", -1),
      ev("B", "search", -1),
      ev("C", "search", -1),
      ev("D", "search", -1),
    ]);
    expect(computeEvolutionTriggers(s)).toEqual([]);
  });

  it("a single -2 does NOT fire on its own — explicit complaints weigh double, no fast path", () => {
    const s = store([ev("A", "card", -2)]);
    expect(computeEvolutionTriggers(s)).toEqual([]);
    // Two complaints (-4) still short; two complaints + one weak signal (-5) fires.
    expect(
      computeEvolutionTriggers(store([ev("A", "card", -2), ev("B", "card", -2)])),
    ).toEqual([]);
    const triggers = computeEvolutionTriggers(
      store([ev("A", "card", -2), ev("B", "card", -2), ev("C", "card", -1)]),
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0].bucket).toBe("card");
  });

  it("approvals (+1) offset the generation net", () => {
    const s = store([
      ev("A", "interaction", -2),
      ev("B", "interaction", -2),
      ev("C", "interaction", -2),
      ev("D", "interaction", 1),
      ev("E", "interaction", 1),
    ]);
    // -6 + 2 = -4 — above the threshold, no trigger.
    expect(computeEvolutionTriggers(s)).toEqual([]);
    // One more weak signal tips it to -5.
    expect(
      computeEvolutionTriggers(store([...s.events, ev("F", "interaction", -1)])),
    ).toHaveLength(1);
  });

  it("scores buckets independently — one bucket's pressure never fires another", () => {
    const s = store([
      ev("A", "recall", -2),
      ev("B", "recall", -2),
      ev("C", "recall", -1),
      ev("A", "interaction", -1),
      ev("B", "interaction", -1),
    ]);
    const triggers = computeEvolutionTriggers(s);
    expect(triggers.map((t) => t.bucket)).toEqual(["recall"]);
  });

  it("delta-0 events (the store's evidence force-zero) are inert", () => {
    const s = store([
      ev("A", "card", 0),
      ev("B", "card", 0),
      ev("C", "card", -1),
    ]);
    expect(computeEvolutionTriggers(s)).toEqual([]);
  });

  it("no trigger → empty list (housekeeping runs NO evolution sub-agent)", () => {
    expect(computeEvolutionTriggers(store([]))).toEqual([]);
    expect(computeEvolutionTriggers(store([ev("A", "interaction", 1)]))).toEqual(
      [],
    );
  });

  it("multiple buckets can fire in the same generation", () => {
    const s = store([
      ev("A", "recall", -2),
      ev("B", "recall", -2),
      ev("C", "recall", -1),
      ev("A", "interaction", -1),
      ev("B", "interaction", -1),
      ev("C", "interaction", -1),
      ev("D", "interaction", -1),
      ev("E", "interaction", -1),
    ]);
    const buckets = computeEvolutionTriggers(s).map((t) => t.bucket);
    expect(buckets).toContain("recall");
    expect(buckets).toContain("interaction");
  });
});
