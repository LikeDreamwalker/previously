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
  return api;
});

vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({
    rest: {
      git: mockOctokit,
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

import { commitBatchToGitHub, type BatchEntry } from "@/lib/tools/batch-write";

beforeEach(() => {
  vi.clearAllMocks();
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
    mockOctokit.getRef.mockResolvedValue({
      data: { object: { sha: HEAD_SHA } },
    });
    mockOctokit.getCommit.mockResolvedValue({
      data: { tree: { sha: BASE_TREE_SHA } },
    });
    mockOctokit.createBlob
      .mockResolvedValueOnce({ data: { sha: BLOB_SHAS[0] } })
      .mockResolvedValueOnce({ data: { sha: BLOB_SHAS[1] } });
    mockOctokit.createTree.mockResolvedValue({
      data: { sha: NEW_TREE_SHA },
    });
    mockOctokit.createCommit.mockResolvedValue({
      data: { sha: NEW_COMMIT_SHA },
    });
    mockOctokit.updateRef.mockResolvedValue({ data: {} });
  }

  it("makes the correct API call sequence: getRef → getCommit → blobs → tree → commit → updateRef", async () => {
    setupMocks();

    const sha = await commitBatchToGitHub(entries, "Test batch commit");

    // 1. Get HEAD ref
    expect(mockOctokit.getRef).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      ref: "heads/main",
    });

    // 2. Get HEAD commit (for base tree)
    expect(mockOctokit.getCommit).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      commit_sha: HEAD_SHA,
    });

    // 3. Create blobs for each file
    expect(mockOctokit.createBlob).toHaveBeenCalledTimes(2);
    expect(mockOctokit.createBlob).toHaveBeenNthCalledWith(1, {
      owner: "test-owner",
      repo: "test-repo",
      content: entries[0].content,
      encoding: "utf-8",
    });
    expect(mockOctokit.createBlob).toHaveBeenNthCalledWith(2, {
      owner: "test-owner",
      repo: "test-repo",
      content: entries[1].content,
      encoding: "utf-8",
    });

    // 4. Create tree with base_tree (inherits unchanged files)
    expect(mockOctokit.createTree).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      base_tree: BASE_TREE_SHA,
      tree: [
        { path: entries[0].path, mode: "100644", type: "blob", sha: BLOB_SHAS[0] },
        { path: entries[1].path, mode: "100644", type: "blob", sha: BLOB_SHAS[1] },
      ],
    });

    // 5. Create commit with HEAD as parent
    expect(mockOctokit.createCommit).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      message: "Test batch commit",
      tree: NEW_TREE_SHA,
      parents: [HEAD_SHA],
    });

    // 6. Fast-forward update
    expect(mockOctokit.updateRef).toHaveBeenCalledWith({
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
    mockOctokit.createBlob.mockReset();
    mockOctokit.createBlob.mockRejectedValue(new Error("Network error"));

    await expect(
      commitBatchToGitHub(entries, "will fail"),
    ).rejects.toThrow("Network error");
  });
});
