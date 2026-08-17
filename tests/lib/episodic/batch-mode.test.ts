/**
 * Tests for io-helpers batch mode — createBatch, flushBatch, read-your-writes,
 * and per-batch isolation (B1: no module-global batch state).
 *
 * Runs against the LOCAL filesystem backend (no GitHub), so we can verify
 * the batch queuing semantics without network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Isolation: use a temp directory + force local backend ──────────────

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-batch-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  // Force the local filesystem backend so writes land in the temp dir.
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

// ── Test subject ───────────────────────────────────────────────────────

async function importFresh() {
  const mod = await import("@/lib/episodic/io-helpers");
  return mod;
}

// ── Helper: write a real file on disk (simulating existing content) ───
function writeOnDisk(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function readOnDisk(relPath: string): string | null {
  const fullPath = path.join(tmpDir, relPath);
  try {
    return fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

describe("io-helpers batch mode (local backend)", () => {
  it("queues writes during batch and commits on flush", async () => {
    const { createBatch, flushBatch, fsWriteFile } = await importFresh();

    const batch = createBatch();

    await fsWriteFile("memory/test/a.md", "content A", batch);
    await fsWriteFile("memory/test/b.md", "content B", batch);

    // Writes should NOT be on disk yet
    expect(readOnDisk("memory/test/a.md")).toBeNull();
    expect(readOnDisk("memory/test/b.md")).toBeNull();

    await flushBatch(batch, "batch commit");

    // After flush, files should be on disk
    expect(readOnDisk("memory/test/a.md")).toBe("content A");
    expect(readOnDisk("memory/test/b.md")).toBe("content B");
  });

  it("read-your-writes: fsReadFile sees pending writes during batch", async () => {
    const { createBatch, flushBatch, fsWriteFile, fsReadFile } =
      await importFresh();

    // Pre-seed a file on disk
    writeOnDisk("memory/test/existing.md", "old content");

    const batch = createBatch();

    await fsWriteFile("memory/test/new.md", "new content", batch);

    // Reading a queued write should return the new content
    const result = await fsReadFile("memory/test/new.md", batch);
    expect(result).toBe("new content");

    // Reading an unmodified file should still hit disk
    const existing = await fsReadFile("memory/test/existing.md", batch);
    expect(existing).toBe("old content");

    await flushBatch(batch, "batch");
  });

  it("read-your-writes: second write overwrites first in same batch", async () => {
    const { createBatch, flushBatch, fsWriteFile, fsReadFile } =
      await importFresh();

    const batch = createBatch();

    await fsWriteFile("memory/test/index.json", "v1", batch);
    // Simulate read-modify-write pattern (like updateMonthlyIndex)
    const current = await fsReadFile("memory/test/index.json", batch);
    const updated = `v2 (was ${current})`;
    await fsWriteFile("memory/test/index.json", updated, batch);

    // Read should see the latest write
    expect(await fsReadFile("memory/test/index.json", batch)).toBe("v2 (was v1)");

    await flushBatch(batch, "batch");

    // Disk should have the final version
    expect(readOnDisk("memory/test/index.json")).toBe("v2 (was v1)");
  });

  it("concurrent batches are isolated — one turn never sees/flushes another's writes", async () => {
    const { createBatch, flushBatch, fsWriteFile, fsReadFile } =
      await importFresh();

    const batchA = createBatch();
    const batchB = createBatch();

    await fsWriteFile("memory/test/turn-a.md", "turn A", batchA);
    await fsWriteFile("memory/test/turn-b.md", "turn B", batchB);

    // B does not see A's queued write (and vice versa)
    await expect(fsReadFile("memory/test/turn-a.md", batchB)).rejects.toThrow();
    expect(await fsReadFile("memory/test/turn-a.md", batchA)).toBe("turn A");

    // Flushing A commits ONLY A's writes
    await flushBatch(batchA, "turn A commit");
    expect(readOnDisk("memory/test/turn-a.md")).toBe("turn A");
    expect(readOnDisk("memory/test/turn-b.md")).toBeNull();

    // B's queue is untouched and still flushable
    await flushBatch(batchB, "turn B commit");
    expect(readOnDisk("memory/test/turn-b.md")).toBe("turn B");
  });

  it("empty batch is a no-op", async () => {
    const { createBatch, flushBatch, fsReadFile } = await importFresh();

    await flushBatch(createBatch(), "empty batch");

    // Should not throw; subsequent reads work normally
    writeOnDisk("memory/test/x.md", "hello");
    expect(await fsReadFile("memory/test/x.md")).toBe("hello");
  });

  it("flush failure keeps the queue so the caller can retry", async () => {
    const { createBatch, flushBatch, fsWriteFile } = await importFresh();

    const batch = createBatch();
    // A path outside the whitelist makes writeFileLocal throw.
    await fsWriteFile("memory/test/ok.md", "ok", batch);
    batch.entries.set("../outside.md", "bad");

    await expect(flushBatch(batch, "will fail")).rejects.toThrow();
    // Entries survive the failure — the finalize self-heal relies on this.
    expect(batch.entries.size).toBe(2);
    expect(batch.entries.get("memory/test/ok.md")).toBe("ok");
  });

  it("writes go directly to disk when no batch is passed", async () => {
    const { fsWriteFile } = await importFresh();

    await fsWriteFile("memory/test/direct.md", "direct write");
    expect(readOnDisk("memory/test/direct.md")).toBe("direct write");
  });
});
