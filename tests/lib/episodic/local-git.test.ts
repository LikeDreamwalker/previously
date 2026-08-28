/**
 * Tests for the local-backend git commit ledger (local-git.ts) and its
 * wiring into io-helpers (fsWriteFile / flushBatch).
 *
 * Uses real isomorphic-git repos in temp dirs (no mocks of git itself), with
 * MEMORY_ROOT pointed at the temp dir and STORAGE=local forcing the local
 * backend. The local-git module is spy-wrapped (importOriginal) so tests can
 * assert call counts while real behavior passes through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import git from "isomorphic-git";

// ── Spy-wrap local-git: real behavior, observable calls ────────────────

vi.mock("@/lib/episodic/local-git", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/episodic/local-git")>();
  return {
    ...original,
    isGitRepo: vi.fn(original.isGitRepo),
    commitPaths: vi.fn(original.commitPaths),
  };
});

// ── Isolation: temp MEMORY_ROOT + forced local backend ─────────────────

let tmpDir: string;
let tmpTasksDir: string;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "STORAGE",
  "MEMORY_ROOT",
  "TASKS_ROOT",
  "PREVIOUSLY_GIT_AUTHOR_NAME",
  "PREVIOUSLY_GIT_AUTHOR_EMAIL",
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-local-git-test-"));
  tmpTasksDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-local-git-tasks-"));
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.STORAGE = "local";
  process.env.MEMORY_ROOT = tmpDir;
  // Keep tasks/ writes out of the real repo working tree.
  process.env.TASKS_ROOT = tmpTasksDir;
  delete process.env.PREVIOUSLY_GIT_AUTHOR_NAME;
  delete process.env.PREVIOUSLY_GIT_AUTHOR_EMAIL;
  // The mocked local-git module instance is shared across resetModules, so
  // its spies accumulate call history — clear it before each test.
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  for (const dir of [tmpDir, tmpTasksDir]) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

async function importLocalGit() {
  return import("@/lib/episodic/local-git");
}

async function importIoHelpers() {
  return import("@/lib/episodic/io-helpers");
}

async function initRepo() {
  await git.init({ fs, dir: tmpDir });
}

function readOnDisk(relToMemoryRoot: string): string | null {
  try {
    return fs.readFileSync(path.join(tmpDir, relToMemoryRoot), "utf-8");
  } catch {
    return null;
  }
}

async function commitLog(filepath?: string) {
  return git.log({ fs, dir: tmpDir, filepath, depth: 50 });
}

// ── isGitRepo ──────────────────────────────────────────────────────────

describe("isGitRepo", () => {
  it("returns false for a plain directory, true after git init", async () => {
    const { isGitRepo } = await importLocalGit();

    expect(isGitRepo(tmpDir)).toBe(false);
    await initRepo();
    expect(isGitRepo(tmpDir)).toBe(true);
  });
});

// ── fsWriteFile wiring (bare write = single commit) ────────────────────

describe("fsWriteFile local git ledger", () => {
  it("bare write produces a single commit with the github-style message", async () => {
    await initRepo();
    const localGit = await importLocalGit();
    const { fsWriteFile } = await importIoHelpers();

    await fsWriteFile("memory/test/direct.md", "direct write");

    expect(readOnDisk("test/direct.md")).toBe("direct write");
    expect(localGit.commitPaths).toHaveBeenCalledTimes(1);
    expect(localGit.commitPaths).toHaveBeenCalledWith(
      tmpDir,
      ["test/direct.md"],
      "Update test/direct.md",
    );

    const log = await commitLog();
    expect(log).toHaveLength(1);
    // isomorphic-git normalizes messages with a trailing newline, like git.
    expect(log[0].commit.message.trim()).toBe("Update test/direct.md");
    // File is actually tracked in the commit.
    expect(await commitLog("test/direct.md")).toHaveLength(1);
  });

  it("default author is Previously <previously@localhost>", async () => {
    await initRepo();
    const { fsWriteFile } = await importIoHelpers();

    await fsWriteFile("memory/test/author.md", "x");

    const log = await commitLog();
    expect(log[0].commit.author.name).toBe("Previously");
    expect(log[0].commit.author.email).toBe("previously@localhost");
  });

  it("PREVIOUSLY_GIT_AUTHOR_NAME/EMAIL override the commit author", async () => {
    process.env.PREVIOUSLY_GIT_AUTHOR_NAME = "Ada";
    process.env.PREVIOUSLY_GIT_AUTHOR_EMAIL = "ada@example.com";
    await initRepo();
    const { fsWriteFile } = await importIoHelpers();

    await fsWriteFile("memory/test/author.md", "x");

    const log = await commitLog();
    expect(log[0].commit.author.name).toBe("Ada");
    expect(log[0].commit.author.email).toBe("ada@example.com");
  });

  it("non-git memory root: zero git calls, write behavior unchanged", async () => {
    // No git init — tmpDir is a plain directory.
    const localGit = await importLocalGit();
    const { fsWriteFile } = await importIoHelpers();

    const result = await fsWriteFile("memory/test/plain.md", "plain");

    expect(result).toEqual({ path: "memory/test/plain.md", created: true });
    expect(readOnDisk("test/plain.md")).toBe("plain");
    expect(localGit.commitPaths).not.toHaveBeenCalled();
    // The ledger must never create a repo on its own.
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(false);
  });

  it("a failing commit never blocks or fails the write", async () => {
    // `.git` as a regular FILE: isGitRepo sees it, but every git operation
    // fails — commitPaths must swallow the error and return false.
    fs.writeFileSync(path.join(tmpDir, ".git"), "not a repo", "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const localGit = await importLocalGit();
    const { fsWriteFile } = await importIoHelpers();

    const result = await fsWriteFile("memory/test/resilient.md", "still written");

    expect(result).toEqual({ path: "memory/test/resilient.md", created: true });
    expect(readOnDisk("test/resilient.md")).toBe("still written");
    expect(localGit.commitPaths).toHaveBeenCalledTimes(1);
    expect(await vi.mocked(localGit.commitPaths).mock.results[0].value).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── flushBatch wiring (batch = N files, 1 commit) ──────────────────────

describe("flushBatch local git ledger", () => {
  it("flush produces a single commit containing all batch files", async () => {
    await initRepo();
    const localGit = await importLocalGit();
    const { createBatch, flushBatch, fsWriteFile } = await importIoHelpers();

    const batch = createBatch();
    await fsWriteFile("memory/batch/a.md", "content A", batch);
    await fsWriteFile("memory/batch/b.md", "content B", batch);
    await flushBatch(batch, "batch commit message");

    expect(readOnDisk("batch/a.md")).toBe("content A");
    expect(readOnDisk("batch/b.md")).toBe("content B");
    expect(localGit.commitPaths).toHaveBeenCalledTimes(1);
    expect(localGit.commitPaths).toHaveBeenCalledWith(
      tmpDir,
      expect.arrayContaining(["batch/a.md", "batch/b.md"]),
      "batch commit message",
    );

    const log = await commitLog();
    expect(log).toHaveLength(1);
    expect(log[0].commit.message.trim()).toBe("batch commit message");
    expect(await commitLog("batch/a.md")).toHaveLength(1);
    expect(await commitLog("batch/b.md")).toHaveLength(1);
  });

  it("flush on a non-git memory root keeps zero-git-call behavior", async () => {
    const localGit = await importLocalGit();
    const { createBatch, flushBatch, fsWriteFile } = await importIoHelpers();

    const batch = createBatch();
    await fsWriteFile("memory/batch/x.md", "x", batch);
    await flushBatch(batch, "batch");

    expect(readOnDisk("batch/x.md")).toBe("x");
    expect(localGit.commitPaths).not.toHaveBeenCalled();
  });

  it("non-memory batch paths are written but excluded from the commit", async () => {
    await initRepo();
    const localGit = await importLocalGit();
    const { createBatch, flushBatch, fsWriteFile } = await importIoHelpers();

    const batch = createBatch();
    await fsWriteFile("memory/batch/m.md", "m", batch);
    // tasks/ is whitelisted but lives outside the memory repo.
    await fsWriteFile("tasks/t.md", "t", batch);
    await flushBatch(batch, "mixed batch");

    expect(localGit.commitPaths).toHaveBeenCalledWith(
      tmpDir,
      ["batch/m.md"],
      "mixed batch",
    );
  });
});
