/**
 * Acceptance rule (src/lib/evolution/acceptance.ts, v1.0 design §2.7):
 * archiving a NEW mutation evaluates the PREVIOUS one on the same target —
 * when the target's bucket kept scoring negative since that previous
 * mutation, an append-only `**Evaluation: ineffective**` line is added;
 * history is never rewritten.
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

  it("does NOT mark when the bucket's net score recovered to ≥ 0", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK } = await import(
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
    expect(readOnDisk("memory/evolution/mutations.md")).not.toContain(
      INEFFECTIVE_MARK,
    );
  });

  it("does NOT mark when the bucket saw NO events since (no evidence either way)", async () => {
    const { appendMutationWithEvaluation, INEFFECTIVE_MARK } = await import(
      "@/lib/evolution/acceptance"
    );
    const store = await import("@/lib/evolution/store");
    await store.appendMutation(mutation(TS_OLD, "card"));

    const outcome = await appendMutationWithEvaluation(
      mutation(TS_NEW, "card"),
      storeWith([{ bucket: "recall", delta: -2 }]), // a different bucket
    );
    expect(outcome.markedIneffective).toBe(false);
    expect(readOnDisk("memory/evolution/mutations.md")).not.toContain(
      INEFFECTIVE_MARK,
    );
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
