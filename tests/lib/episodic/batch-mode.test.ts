/**
 * Tests for io-helpers batch mode — startBatch, flushBatch, read-your-writes.
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
    const { startBatch, flushBatch, fsWriteFile } = await importFresh();

    startBatch();

    await fsWriteFile("memory/test/a.md", "content A");
    await fsWriteFile("memory/test/b.md", "content B");

    // Writes should NOT be on disk yet
    expect(readOnDisk("memory/test/a.md")).toBeNull();
    expect(readOnDisk("memory/test/b.md")).toBeNull();

    await flushBatch("batch commit");

    // After flush, files should be on disk
    expect(readOnDisk("memory/test/a.md")).toBe("content A");
    expect(readOnDisk("memory/test/b.md")).toBe("content B");
  });

  it("read-your-writes: fsReadFile sees pending writes during batch", async () => {
    const { startBatch, flushBatch, fsWriteFile, fsReadFile } =
      await importFresh();

    // Pre-seed a file on disk
    writeOnDisk("memory/test/existing.md", "old content");

    startBatch();

    await fsWriteFile("memory/test/new.md", "new content");

    // Reading a queued write should return the new content
    const result = await fsReadFile("memory/test/new.md");
    expect(result).toBe("new content");

    // Reading an unmodified file should still hit disk
    const existing = await fsReadFile("memory/test/existing.md");
    expect(existing).toBe("old content");

    await flushBatch("batch");
  });

  it("read-your-writes: second write overwrites first in same batch", async () => {
    const { startBatch, flushBatch, fsWriteFile, fsReadFile } =
      await importFresh();

    startBatch();

    await fsWriteFile("memory/test/index.json", "v1");
    // Simulate read-modify-write pattern (like updateMonthlyIndex)
    const current = await fsReadFile("memory/test/index.json");
    const updated = `v2 (was ${current})`;
    await fsWriteFile("memory/test/index.json", updated);

    // Read should see the latest write
    expect(await fsReadFile("memory/test/index.json")).toBe("v2 (was v1)");

    await flushBatch("batch");

    // Disk should have the final version
    expect(readOnDisk("memory/test/index.json")).toBe("v2 (was v1)");
  });

  it("empty batch is a no-op", async () => {
    const { startBatch, flushBatch, fsReadFile } = await importFresh();

    startBatch();
    await flushBatch("empty batch");

    // Should not throw, state should be clean
    // Subsequent reads should work normally
    writeOnDisk("memory/test/x.md", "hello");
    expect(await fsReadFile("memory/test/x.md")).toBe("hello");
  });

  it("writes go directly to disk when not batching", async () => {
    const { fsWriteFile } = await importFresh();

    await fsWriteFile("memory/test/direct.md", "direct write");
    expect(readOnDisk("memory/test/direct.md")).toBe("direct write");
  });
});
