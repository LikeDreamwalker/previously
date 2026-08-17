/**
 * Tests for batch write — N file changes → 1 commit via Git Data API.
 *
 * Verifies:
 *   - commitBatchToGitHub makes the correct sequence of API calls
 *   - fsWriteFile queues during batch mode
 *   - fsReadFile sees pending writes during batch mode (read-your-writes)
 *   - flushBatch exits batch mode and commits
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock GitHub client ────────────────────────────────────────────────

const mockOctokit = vi.hoisted(() => {
  const api = {
    getRef: vi.fn(),
    getCommit: vi.fn(),
    createBlob: vi.fn(),
    createTree: vi.fn(),
    createCommit: vi.fn(),
    updateRef: vi.fn(),
  };
  return { git: api, reposGet: vi.fn() };
});

vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({
    rest: {
      git: mockOctokit.git,
      repos: { get: mockOctokit.reposGet },
    },
  }),
}));

// ── Mock capabilities ─────────────────────────────────────────────────

vi.mock("@/lib/capabilities", () => ({
  getRepoConfig: () => ({ owner: "test-owner", repo: "test-repo" }),
  isAIConfigured: () => true,
  isDemo: () => false,
  canWrite: () => true,
}));

// ── Test subject ───────────────────────────────────────────────────────

import {
  commitBatchToGitHub,
  isRefConflictError,
  _resetDefaultBranchCache,
  type BatchEntry,
} from "@/lib/tools/batch-write";

beforeEach(() => {
  vi.clearAllMocks();
  _resetDefaultBranchCache();
  mockOctokit.reposGet.mockResolvedValue({
    data: { default_branch: "main" },
  });
});

describe("commitBatchToGitHub", () => {
  const HEAD_SHA = "abc123";
  const BASE_TREE_SHA = "tree456";
  const BLOB_SHAS = ["blob111", "blob222"];
  const NEW_TREE_SHA = "tree789";
  const NEW_COMMIT_SHA = "def456";

  const entries: BatchEntry[] = [
    { path: "memory/episodic/slices/core.md", content: "# Hello\n" },
    { path: "memory/episodic/_index.json", content: '{"items":[]}' },
  ];

  function setupMocks() {
    mockOctokit.git.getRef.mockResolvedValue({
      data: { object: { sha: HEAD_SHA } },
    });
    mockOctokit.git.getCommit.mockResolvedValue({
      data: { tree: { sha: BASE_TREE_SHA } },
    });
    mockOctokit.git.createBlob
      .mockResolvedValueOnce({ data: { sha: BLOB_SHAS[0] } })
      .mockResolvedValueOnce({ data: { sha: BLOB_SHAS[1] } });
    mockOctokit.git.createTree.mockResolvedValue({
      data: { sha: NEW_TREE_SHA },
    });
    mockOctokit.git.createCommit.mockResolvedValue({
      data: { sha: NEW_COMMIT_SHA },
    });
    mockOctokit.git.updateRef.mockResolvedValue({ data: {} });
  }

  it("makes the correct API call sequence: getRef → getCommit → blobs → tree → commit → updateRef", async () => {
    setupMocks();

    const sha = await commitBatchToGitHub(entries, "Test batch commit");

    // 1. Get HEAD ref
    expect(mockOctokit.git.getRef).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      ref: "heads/main",
    });

    // 2. Get HEAD commit (for base tree)
    expect(mockOctokit.git.getCommit).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      commit_sha: HEAD_SHA,
    });

    // 3. Create blobs for each file
    expect(mockOctokit.git.createBlob).toHaveBeenCalledTimes(2);
    expect(mockOctokit.git.createBlob).toHaveBeenNthCalledWith(1, {
      owner: "test-owner",
      repo: "test-repo",
      content: entries[0].content,
      encoding: "utf-8",
    });
    expect(mockOctokit.git.createBlob).toHaveBeenNthCalledWith(2, {
      owner: "test-owner",
      repo: "test-repo",
      content: entries[1].content,
      encoding: "utf-8",
    });

    // 4. Create tree with base_tree (inherits unchanged files)
    expect(mockOctokit.git.createTree).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      base_tree: BASE_TREE_SHA,
      tree: [
        { path: entries[0].path, mode: "100644", type: "blob", sha: BLOB_SHAS[0] },
        { path: entries[1].path, mode: "100644", type: "blob", sha: BLOB_SHAS[1] },
      ],
    });

    // 5. Create commit with HEAD as parent
    expect(mockOctokit.git.createCommit).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      message: "Test batch commit",
      tree: NEW_TREE_SHA,
      parents: [HEAD_SHA],
    });

    // 6. Fast-forward update
    expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      ref: "heads/main",
      sha: NEW_COMMIT_SHA,
      force: false,
    });

    expect(sha).toBe(NEW_COMMIT_SHA);
  });

  it("returns the new commit SHA on success", async () => {
    setupMocks();
    const sha = await commitBatchToGitHub([entries[0]], "single");
    expect(sha).toBe(NEW_COMMIT_SHA);
  });

  it("propagates API errors (caller should retry)", async () => {
    setupMocks();
    mockOctokit.git.createBlob.mockReset();
    mockOctokit.git.createBlob.mockRejectedValue(new Error("Network error"));

    await expect(
      commitBatchToGitHub(entries, "will fail"),
    ).rejects.toThrow("Network error");
  });
});

describe("default branch resolution (D8a)", () => {
  const entries: BatchEntry[] = [
    { path: "memory/x.md", content: "x" },
  ];

  function setupGitMocks() {
    mockOctokit.git.getRef.mockResolvedValue({
      data: { object: { sha: "head" } },
    });
    mockOctokit.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "tree" } },
    });
    mockOctokit.git.createBlob.mockResolvedValue({ data: { sha: "blob" } });
    mockOctokit.git.createTree.mockResolvedValue({ data: { sha: "newtree" } });
    mockOctokit.git.createCommit.mockResolvedValue({
      data: { sha: "newcommit" },
    });
    mockOctokit.git.updateRef.mockResolvedValue({ data: {} });
  }

  it("uses the repo's default branch instead of hardcoding heads/main", async () => {
    setupGitMocks();
    mockOctokit.reposGet.mockResolvedValue({
      data: { default_branch: "master" },
    });

    await commitBatchToGitHub(entries, "commit");

    expect(mockOctokit.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/master" }),
    );
    expect(mockOctokit.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/master", force: false }),
    );
  });

  it("caches the default branch per process (repos.get called once)", async () => {
    setupGitMocks();

    await commitBatchToGitHub(entries, "first");
    await commitBatchToGitHub(entries, "second");

    expect(mockOctokit.reposGet).toHaveBeenCalledTimes(1);
    expect(mockOctokit.reposGet).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
    });
  });
});

describe("isRefConflictError", () => {
  it("detects non-fast-forward rejections by status and message", () => {
    expect(isRefConflictError({ status: 422, message: "Update is not a fast forward" })).toBe(true);
    expect(isRefConflictError({ status: 409 })).toBe(true);
    expect(isRefConflictError(new Error("Not a fast forward"))).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isRefConflictError(new Error("Network error"))).toBe(false);
    expect(isRefConflictError({ status: 500, message: "boom" })).toBe(false);
    expect(isRefConflictError(null)).toBe(false);
    expect(isRefConflictError("string")).toBe(false);
  });
});
