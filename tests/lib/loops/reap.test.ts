/**
 * Tests for the loop zombie reaper (B3) — stale "running" records are marked
 * "interrupted"; fresh/other-terminal records and the current loop are left.
 *
 * Runs against the LOCAL filesystem backend in a temp directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-loops-test-"));
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

const HOUR = 3_600_000;

function loopRun(overrides: Record<string, unknown> = {}) {
  return {
    loopId: "loop-1",
    goal: "test goal",
    status: "running" as const,
    startedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
    sliceOrigin: null,
    tags: [],
    iterations: 1,
    maxIterations: 6,
    lastError: "",
    steps: [
      { step: 1, action: "a", result: "r", time: new Date().toISOString() },
    ],
    ...overrides,
  };
}

async function writeLoop(loop: ReturnType<typeof loopRun>, fileName?: string) {
  const { writeLoopFile, serializeLoop } = await import("@/lib/loops/store");
  const p = `memory/loops/2026/08/16/${fileName ?? loop.loopId}.md`;
  await writeLoopFile(p, serializeLoop(loop as never));
  return p;
}

describe("reapZombieLoops (local backend)", () => {
  it("marks a stale running record as interrupted", async () => {
    const { reapZombieLoops, readLoopRun } = await import("@/lib/loops/store");
    const p = await writeLoop(loopRun());

    const reaped = await reapZombieLoops("loop-current");
    expect(reaped).toEqual(["loop-1"]);

    const after = await readLoopRun(p);
    expect(after?.status).toBe("interrupted");
    expect(after?.lastError).toContain("reaped");
    // Steps survive the reap.
    expect(after?.steps).toHaveLength(1);
  });

  it("leaves a FRESH running record alone", async () => {
    const { reapZombieLoops, readLoopRun } = await import("@/lib/loops/store");
    const p = await writeLoop(
      loopRun({ updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() }),
    );

    const reaped = await reapZombieLoops("loop-current");
    expect(reaped).toEqual([]);
    expect((await readLoopRun(p))?.status).toBe("running");
  });

  it("never reaps the CURRENT loop", async () => {
    const { reapZombieLoops, readLoopRun } = await import("@/lib/loops/store");
    const p = await writeLoop(loopRun({ loopId: "loop-self" }), "loop-self");

    const reaped = await reapZombieLoops("loop-self");
    expect(reaped).toEqual([]);
    expect((await readLoopRun(p))?.status).toBe("running");
  });

  it("leaves terminal records (completed/failed) alone", async () => {
    const { reapZombieLoops, readLoopRun } = await import("@/lib/loops/store");
    const p = await writeLoop(loopRun({ loopId: "loop-done", status: "completed" }), "loop-done");

    const reaped = await reapZombieLoops("loop-current");
    expect(reaped).toEqual([]);
    expect((await readLoopRun(p))?.status).toBe("completed");
  });

  it("returns [] when no loops exist", async () => {
    const { reapZombieLoops } = await import("@/lib/loops/store");
    await expect(reapZombieLoops("loop-x")).resolves.toEqual([]);
  });
});

describe("loop record deadline round-trip (B4)", () => {
  it("serializes and reads back deadline_at", async () => {
    const { writeLoopFile, serializeLoop, readLoopRun } = await import(
      "@/lib/loops/store"
    );
    const deadline = new Date(Date.now() + 2 * HOUR).toISOString();
    const p = `memory/loops/2026/08/16/loop-dl.md`;
    await writeLoopFile(p, serializeLoop(loopRun({ deadlineAt: deadline }) as never));

    const read = await readLoopRun(p);
    expect(read?.deadlineAt).toBe(deadline);
  });
});
