/**
 * Tests for the evolution data layer store (src/lib/evolution/store.ts):
 * the structural evidence-anchoring invariant, window net-score math, bounded
 * retention, the mutation archive format, and missing-file tolerance.
 *
 * Same harness as tests/lib/episodic/batch-mode.test.ts: a temp cwd +
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-evolution-test-"));
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

async function importFresh() {
  return import("@/lib/evolution/store");
}

function readOnDisk(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

function writeOnDisk(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

// ── Missing-file tolerance ───────────────────────────────────────────────

describe("missing-file tolerance", () => {
  it("readDirection / readPlaybook return null when the files do not exist", async () => {
    const store = await importFresh();
    expect(await store.readDirection()).toBeNull();
    expect(await store.readPlaybook("recall")).toBeNull();
  });

  it("readFitness returns the empty store when fitness.json is missing", async () => {
    const store = await importFresh();
    expect(await store.readFitness()).toEqual({ events: [], signals: [] });
  });

  it("readFitness degrades to the empty store on a CORRUPT file", async () => {
    writeOnDisk("memory/evolution/fitness.json", "{not json");
    const store = await importFresh();
    expect(await store.readFitness()).toEqual({ events: [], signals: [] });
  });

  it("readRecentSignals returns [] when nothing was ever recorded", async () => {
    const store = await importFresh();
    expect(await store.readRecentSignals(5)).toEqual([]);
  });

  it("ensureEvolutionFiles creates direction.md from the template, then never overwrites", async () => {
    const store = await importFresh();
    await store.ensureEvolutionFiles();
    const created = readOnDisk("memory/evolution/direction.md");
    expect(created).not.toBeNull();
    for (const section of ["# Portrait", "# Hypotheses", "# Evidence", "# Log"]) {
      expect(created).toContain(section);
    }

    // Existing content must survive a second ensure.
    writeOnDisk("memory/evolution/direction.md", "# Direction\n\nCustom evolved content.");
    await store.ensureEvolutionFiles();
    expect(readOnDisk("memory/evolution/direction.md")).toBe(
      "# Direction\n\nCustom evolved content.",
    );
  });
});

// ── Bootstrap gate helper ────────────────────────────────────────────────

describe("isDirectionTemplate", () => {
  it("is true for null (missing file) and the untouched template, false once written", async () => {
    const store = await importFresh();
    expect(store.isDirectionTemplate(null)).toBe(true);

    await store.ensureEvolutionFiles();
    expect(store.isDirectionTemplate(await store.readDirection())).toBe(true);

    expect(
      store.isDirectionTemplate("# Direction\n\nCustom evolved content."),
    ).toBe(false);
  });
});

// ── Evidence-anchoring invariant ─────────────────────────────────────────

describe("appendFitnessEvents evidence invariant", () => {
  it("forces delta to 0 when evidence is empty or whitespace", async () => {
    const store = await importFresh();
    await store.appendFitnessEvents([
      { ts: "2026-08-27T10:00:00Z", sliceId: "2026-08-27-1000", bucket: "recall", delta: 1, evidence: "" },
      { ts: "2026-08-27T10:01:00Z", sliceId: "2026-08-27-1000", bucket: "card", delta: -2, evidence: "   " },
      { ts: "2026-08-27T10:02:00Z", sliceId: "2026-08-27-1000", bucket: "search", delta: 1, evidence: "user said: thanks, exactly what I needed" },
    ]);
    const { events } = await store.readFitness();
    expect(events.map((e) => e.delta)).toEqual([0, 0, 1]);
  });
});

// ── Window net-score math ────────────────────────────────────────────────

describe("bucketNetScore", () => {
  it("nets a bucket over the newest N distinct slices", async () => {
    const { bucketNetScore } = await importFresh();
    const store = {
      signals: [],
      events: [
        // slice A (oldest)
        { ts: "t1", sliceId: "A", bucket: "recall" as const, delta: -2 as const, evidence: "x" },
        { ts: "t2", sliceId: "A", bucket: "card" as const, delta: 1 as const, evidence: "x" },
        // slice B
        { ts: "t3", sliceId: "B", bucket: "recall" as const, delta: -1 as const, evidence: "x" },
        // slice C (newest)
        { ts: "t4", sliceId: "C", bucket: "recall" as const, delta: 1 as const, evidence: "x" },
      ],
    };
    // Full window: recall = -2 + -1 + 1 = -2; card = +1.
    expect(bucketNetScore(store, "recall")).toBe(-2);
    expect(bucketNetScore(store, "card")).toBe(1);
    expect(bucketNetScore(store, "search")).toBe(0);
    // Window of the 2 newest slices (B, C) drops slice A's -2: recall = 0.
    expect(bucketNetScore(store, "recall", 2)).toBe(0);
    // Window of 1 newest slice (C): recall = +1.
    expect(bucketNetScore(store, "recall", 1)).toBe(1);
  });
});

// ── Since-window net-score (effectiveness window, design §2.7) ────────────

describe("bucketNetScoreSince", () => {
  it("nets a bucket over events strictly NEWER than the cutoff timestamp", async () => {
    const { bucketNetScoreSince } = await importFresh();
    const store = {
      signals: [],
      events: [
        { ts: "2026-08-20T10:00:00Z", sliceId: "A", bucket: "recall" as const, delta: -2 as const, evidence: "x" },
        { ts: "2026-08-22T10:00:00Z", sliceId: "B", bucket: "recall" as const, delta: -1 as const, evidence: "x" },
        { ts: "2026-08-22T11:00:00Z", sliceId: "B", bucket: "card" as const, delta: -1 as const, evidence: "x" },
        { ts: "2026-08-24T10:00:00Z", sliceId: "C", bucket: "recall" as const, delta: 1 as const, evidence: "x" },
      ],
    };
    // Since before everything: all recall events = -2.
    expect(bucketNetScoreSince(store, "recall", "2026-08-19T00:00:00Z")).toBe(-2);
    // Since between the recall events: -1 + 1 = 0 (other buckets never count).
    expect(bucketNetScoreSince(store, "recall", "2026-08-21T00:00:00Z")).toBe(0);
    // Strictly newer: the event AT the cutoff is excluded.
    expect(bucketNetScoreSince(store, "recall", "2026-08-22T10:00:00Z")).toBe(1);
    // After everything: 0.
    expect(bucketNetScoreSince(store, "recall", "2026-08-25T00:00:00Z")).toBe(0);
  });
});

// ── Bounded retention ────────────────────────────────────────────────────

describe("bounded retention", () => {
  it("retains only the newest MAX_FITNESS_EVENTS events", async () => {
    const store = await importFresh();
    const total = store.MAX_FITNESS_EVENTS + 25;
    for (let i = 0; i < total; i++) {
      await store.appendFitnessEvents([
        {
          ts: `t${i}`,
          sliceId: "s",
          bucket: "interaction",
          delta: 0,
          evidence: `e${i}`,
        },
      ]);
    }
    const { events } = await store.readFitness();
    expect(events).toHaveLength(store.MAX_FITNESS_EVENTS);
    // Newest kept, oldest dropped.
    expect(events[0].evidence).toBe("e25");
    expect(events[events.length - 1].evidence).toBe(`e${total - 1}`);
  });

  it("retains only the newest MAX_FITNESS_SIGNALS signals and serves readRecentSignals", async () => {
    const store = await importFresh();
    for (let i = 0; i < store.MAX_FITNESS_SIGNALS + 10; i++) {
      await store.appendSignal({
        ts: `t${i}`,
        sliceId: "s",
        type: "recall_rework",
        detail: `d${i}`,
      });
    }
    const { signals } = await store.readFitness();
    expect(signals).toHaveLength(store.MAX_FITNESS_SIGNALS);
    expect(signals[0].detail).toBe("d10");

    const recent = await store.readRecentSignals(3);
    expect(recent.map((s) => s.detail)).toEqual([
      `d${store.MAX_FITNESS_SIGNALS + 7}`,
      `d${store.MAX_FITNESS_SIGNALS + 8}`,
      `d${store.MAX_FITNESS_SIGNALS + 9}`,
    ]);
  });
});

// ── Mutation archive ─────────────────────────────────────────────────────

describe("appendMutation", () => {
  it("creates the archive with a header, then appends compact blocks", async () => {
    const store = await importFresh();
    await store.appendMutation({
      ts: "2026-08-27T10:00:00Z",
      target: "playbook:recall",
      summary: "Prefer full-slice reads on emotional topics",
      evidence: ["memory/episodic/slices/2026/08/20/1430/timeline/core.md"],
      expectedBenefit: "Fewer rework signals on emotional recalls",
    });
    const first = readOnDisk("memory/evolution/mutations.md");
    expect(first).not.toBeNull();
    expect(first).toContain("# Mutations Archive");
    expect(first).toContain("## 2026-08-27T10:00:00Z — playbook:recall");
    expect(first).toContain("- **Summary:** Prefer full-slice reads on emotional topics");
    expect(first).toContain("- **Expected benefit:** Fewer rework signals on emotional recalls");
    expect(first).toContain("  - memory/episodic/slices/2026/08/20/1430/timeline/core.md");

    await store.appendMutation({
      ts: "2026-08-27T11:00:00Z",
      target: "direction",
      summary: "Direction: prioritize continuity of long-running projects",
      evidence: [],
      expectedBenefit: "Better multi-session follow-through",
    });
    const second = readOnDisk("memory/evolution/mutations.md")!;
    // Append-only: the first block is untouched, the header appears once.
    expect(second.indexOf("# Mutations Archive")).toBe(
      second.lastIndexOf("# Mutations Archive"),
    );
    expect(second).toContain("## 2026-08-27T10:00:00Z — playbook:recall");
    expect(second).toContain("## 2026-08-27T11:00:00Z — direction");
    expect(second).toContain("  - (none recorded)");
    expect(second.indexOf("## 2026-08-27T10:00:00Z")).toBeLessThan(
      second.indexOf("## 2026-08-27T11:00:00Z"),
    );
  });
});

// ── Playbook IO ──────────────────────────────────────────────────────────

describe("playbook IO", () => {
  it("round-trips a playbook and caps the injected length with a marker", async () => {
    const store = await importFresh();
    expect(await store.readPlaybook("thinkdeep")).toBeNull();

    await store.writePlaybook("thinkdeep", "State the missing facts first.");
    expect(await store.readPlaybook("thinkdeep")).toBe(
      "State the missing facts first.",
    );

    const long = "x".repeat(store.MAX_PLAYBOOK_CHARS + 500);
    const capped = store.capPlaybook(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain("playbook truncated");
    expect(store.capPlaybook("short")).toBe("short");
  });
});
