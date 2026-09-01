/**
 * Acceptance rule (src/lib/evolution/acceptance.ts, v1.0 design §2.7):
 * archiving a NEW mutation evaluates the PREVIOUS one on the same target —
 * the target's bucket net score since that previous mutation decides the
 * append-only verdict line: negative → `**Evaluation: ineffective**`,
 * positive → `**Evaluation: effective**`, zero → no line (inconclusive);
 * history is never rewritten. mutationTrackRecord tallies the archive as the
 * loop's honesty feedback.
 *
 * Same harness as tests/lib/evolution/store.test.ts: a temp cwd +
 * STORAGE=local so all I/O lands on the local filesystem backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-acceptance-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  process.env.STORAGE = "local";
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) {
    process.env.STORAGE = origStorage;
  } else {
    delete process.env.STORAGE;
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function readOnDisk(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

import type { MutationRecord } from "@/lib/evolution/store";

const TS_OLD = "2026-08-20T10:00:00.000Z";
const TS_NEW = "2026-08-27T10:00:00.000Z";

function mutation(
  ts: string,
  target: "card" | "playbook:recall",
): MutationRecord {
  return {
    ts,
    target,
    summary: `mutation at ${ts}`,
    evidence: ["2026-08-20-1000"],
    expectedBenefit: "fewer complaints",
  };
}

/** A fitness store whose card/recall events all postdate TS_OLD. */
function storeWith(events: Array<{ bucket: "card" | "recall"; delta: -2 | -1 | 0 | 1 }>) {
  return {
    signals: [],
    directionRejections: [],
    events: events.map((e, i) => ({
      ts: `2026-08-2${4 + i}T10:00:00.000Z`,
      sliceId: `s${i}`,
      bucket: e.bucket,
      delta: e.delta,
      evidence: "user's words",
    })),
  };
}

// ── Pure parsing ─────────────────────────────────────────────────────────

describe("findLastMutationForTarget", () => {
  it("returns the LAST record for the target, ignoring others", async () => {
    const { findLastMutationForTarget } = await import("@/lib/evolution/acceptance");
    const content = [
      "# Mutations Archive",
      "",
      `## ${TS_OLD} — card`,
      "",
      "- **Summary:** first",
      "",
      "## 2026-08-21T10:00:00.000Z — playbook:recall",
      "",
      "- **Summary:** other target",
      "",
      "## 2026-08-22T10:00:00.000Z — card",
      "",
      "- **Summary:** second",
    ].join("\n");
    expect(findLastMutationForTarget(content, "card")?.ts).toBe(
      "2026-08-22T10:00:00.000Z",
    );
    expect(findLastMutationForTarget(content, "playbook:recall")?.ts).toBe(
      "2026-08-21T10:00:00.000Z",
    );
    expect(findLastMutationForTarget(content, "playbook:search")).toBeNull();
    expect(findLastMutationForTarget("", "card")).toBeNull();
  });
});

// ── The effectiveness window ─────────────────────────────────────────────

describe("appendMutationWithEvaluation", () => {
  it("marks the previous mutation ineffective when its bucket kept losing points", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    await store.appendMutation(mutation(TS_OLD, "card"));

    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "card"),
      storeWith([{ bucket: "card", delta: -1 }]),
    );
    expect(outcome.evaluatedPreviousTs).toBe(TS_OLD);
    expect(outcome.markedIneffective).toBe(true);

    const content = readOnDisk("memory/evolution/mutations.md")!;
    expect(content).toContain(INEFFECTIVE_MARK);
    expect(content).toContain(`${TS_OLD} card`);
    // Append-only: both records survive, evaluation before the new record.
    expect(content.indexOf(INEFFECTIVE_MARK)).toBeLessThan(
      content.indexOf(`## ${TS_NEW} — card`),
    );
    expect(content).toContain(`## ${TS_OLD} — card`);
    expect(content).toContain(`## ${TS_NEW} — card`);
  });

  it("does NOT mark when the bucket's net score is exactly 0 (inconclusive — no line either way)", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK, EFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    await store.appendMutation(mutation(TS_OLD, "card"));

    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "card"),
      storeWith([{ bucket: "card", delta: -1 }, { bucket: "card", delta: 1 }]),
    );
    expect(outcome.evaluatedPreviousTs).toBe(TS_OLD);
    expect(outcome.markedIneffective).toBe(false);
    expect(outcome.markedEffective).toBe(false);
    const content = readOnDisk("memory/evolution/mutations.md")!;
    expect(content).not.toContain(INEFFECTIVE_MARK);
    expect(content).not.toContain(EFFECTIVE_MARK);
  });

  it("marks the previous mutation EFFECTIVE when its bucket's net score turned positive", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK, EFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    await store.appendMutation(mutation(TS_OLD, "card"));

    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "card"),
      storeWith([{ bucket: "card", delta: 1 }, { bucket: "card", delta: 1 }]),
    );
    expect(outcome.evaluatedPreviousTs).toBe(TS_OLD);
    expect(outcome.markedEffective).toBe(true);
    expect(outcome.markedIneffective).toBe(false);

    const content = readOnDisk("memory/evolution/mutations.md")!;
    expect(content).toContain(EFFECTIVE_MARK);
    expect(content).not.toContain(INEFFECTIVE_MARK);
    expect(content).toContain(`${TS_OLD} card`);
    // Append-only: the evaluation line lands before the new record.
    expect(content.indexOf(EFFECTIVE_MARK)).toBeLessThan(
      content.indexOf(`## ${TS_NEW} — card`),
    );
  });

  it("does NOT mark when the bucket saw NO events since (no evidence either way)", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK, EFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    await store.appendMutation(mutation(TS_OLD, "card"));

    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "card"),
      storeWith([{ bucket: "recall", delta: -2 }]), // a different bucket
    );
    expect(outcome.markedIneffective).toBe(false);
    expect(outcome.markedEffective).toBe(false);
    const content = readOnDisk("memory/evolution/mutations.md")!;
    expect(content).not.toContain(INEFFECTIVE_MARK);
    expect(content).not.toContain(EFFECTIVE_MARK);
  });

  it("a first-ever mutation for a target has nothing to evaluate", async () => {
    const { appendMutationWithEvaluation } = await import(
      "@/lib/evolution/acceptance"
    );
    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "playbook:recall"),
      storeWith([{ bucket: "recall", delta: -2 }]),
    );
    expect(outcome.evaluatedPreviousTs).toBeNull();
    expect(outcome.markedIneffective).toBe(false);
    expect(readOnDisk("memory/evolution/mutations.md")).toContain(
      `## ${TS_NEW} — playbook:recall`,
    );
  });

  it("evaluates a playbook target against ITS bucket (playbook:recall → recall)", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    await store.appendMutation(mutation(TS_OLD, "playbook:recall"));

    // Recall kept bleeding after the playbook rewrite → ineffective, even
    // though the CARD bucket recovered.
    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "playbook:recall"),
      storeWith([{ bucket: "recall", delta: -1 }, { bucket: "card", delta: 1 }]),
    );
    expect(outcome.markedIneffective).toBe(true);
    expect(readOnDisk("memory/evolution/mutations.md")).toContain(
      "the recall bucket kept scoring negative",
    );
    expect(readOnDisk("memory/evolution/mutations.md")).toContain(INEFFECTIVE_MARK);
  });
});

// ── The honesty feedback tally ───────────────────────────────────────────

describe("mutationTrackRecord", () => {
  it("counts effective / ineffective / unevaluated records (playbook targets included)", async () => {
    const { mutationTrackRecord } = await import("@/lib/evolution/acceptance");
    const content = [
      "# Mutations Archive",
      "",
      `## ${TS_OLD} — card`,
      "",
      "- **Summary:** first",
      "",
      "## 2026-08-21T10:00:00.000Z — playbook:recall",
      "",
      "- **Summary:** second",
      "",
      `- **Evaluation: ineffective** — ${TS_OLD} card: the card bucket kept scoring negative after this mutation (net -2 since).`,
      "",
      `## ${TS_NEW} — card`,
      "",
      "- **Summary:** third",
      "",
      "- **Evaluation: effective** — 2026-08-21T10:00:00.000Z playbook:recall: the recall bucket stopped losing points after this mutation (net +1 since).",
      "",
      "## 2026-08-28T10:00:00.000Z — direction",
      "",
      "- **Summary:** fourth",
    ].join("\n");
    expect(mutationTrackRecord(content)).toEqual({
      effective: 1,
      ineffective: 1,
      // The newest card record + the direction record await their evaluation.
      unevaluated: 2,
    });
  });

  it("an empty archive is all zeros", async () => {
    const { mutationTrackRecord } = await import("@/lib/evolution/acceptance");
    expect(mutationTrackRecord("")).toEqual({
      effective: 0,
      ineffective: 0,
      unevaluated: 0,
    });
  });
});

// ── The minimum observation window (v0.9.1) ──────────────────────────────

describe("hasEvaluationWindow", () => {
  it("passes on age alone (≥24h), even with zero events since", async () => {
    const { hasEvaluationWindow } = await import("@/lib/evolution/acceptance");
    expect(hasEvaluationWindow(storeWith([]), TS_OLD)).toBe(true);
  });

  it("passes on sample alone (≥ MIN_EVALUATION_EVENTS events), even for a fresh mutation", async () => {
    const { hasEvaluationWindow, MIN_EVALUATION_EVENTS } = await import(
      "@/lib/evolution/acceptance"
    );
    const prev = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const fresh = new Date(Date.now() - 30_000).toISOString(); // events newer than prev
    const store = {
      signals: [],
      directionRejections: [],
      events: Array.from({ length: MIN_EVALUATION_EVENTS }, (_, i) => ({
        ts: fresh,
        sliceId: `s${i}`,
        bucket: "card" as const,
        delta: 0 as const,
        evidence: "e",
      })),
    };
    expect(hasEvaluationWindow(store, prev)).toBe(true);
  });

  it("fails when the mutation is fresh AND the sample is thin", async () => {
    const { hasEvaluationWindow, MIN_EVALUATION_EVENTS } = await import(
      "@/lib/evolution/acceptance"
    );
    const prev = new Date(Date.now() - 60_000).toISOString();
    const fresh = new Date(Date.now() - 30_000).toISOString();
    const store = {
      signals: [],
      directionRejections: [],
      events: Array.from({ length: MIN_EVALUATION_EVENTS - 1 }, (_, i) => ({
        ts: fresh,
        sliceId: `s${i}`,
        bucket: "card" as const,
        delta: -1 as const,
        evidence: "e",
      })),
    };
    expect(hasEvaluationWindow(store, prev)).toBe(false);
  });
});

describe("appendMutationWithEvaluation — thin window gate", () => {
  it("writes NO verdict line when the previous mutation is minutes old with a thin sample (stays unevaluated)", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK, EFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    // The previous mutation landed just now — a same-complaint follow-up must
    // not judge it (the inclusive ≤ -1 trigger makes this the common case).
    const tsPrev = new Date().toISOString();
    await store.appendMutation(mutation(tsPrev, "card"));

    const outcome = await appendMutationWithEvaluation(
      mutation(new Date().toISOString(), "card"),
      storeWith([{ bucket: "card", delta: -1 }]),
    );
    expect(outcome.markedIneffective).toBe(false);
    expect(outcome.markedEffective).toBe(false);
    const content = readOnDisk("memory/evolution/mutations.md")!;
    expect(content).not.toContain(INEFFECTIVE_MARK);
    expect(content).not.toContain(EFFECTIVE_MARK);
    // Both records still archived — only the verdict was deferred.
    expect(content).toContain(`— card`);
  });
});
