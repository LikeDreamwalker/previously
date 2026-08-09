import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock octokit
const mockGetContent = vi.fn();
vi.mock("@/lib/github/client", () => ({
  getOctokit: () => ({
    rest: {
      repos: {
        getContent: mockGetContent,
      },
    },
  }),
}));

import { readFile, __resetReadCache } from "@/lib/tools/readFile";

describe("readFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The read cache is module-level — reset between cases so a cached file
    // from a previous test can't mask a changed mock.
    __resetReadCache();
  });

  const repo = "test-repo";
  const owner = "test-owner";

  it("rejects path outside allowed directories", async () => {
    await expect(readFile("src/app/layout.tsx", repo, owner)).rejects.toThrow(
      "Access denied"
    );
  });

  it("rejects path traversal to src/", async () => {
    await expect(
      readFile("memory/../../src/app/layout.tsx", repo, owner)
    ).rejects.toThrow("Access denied");
  });

  it("reads a file from an allowed path", async () => {
    mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        name: "test.md",
        path: "memory/test.md",
        size: 13,
        encoding: "base64",
        content: Buffer.from("Hello, World!").toString("base64"),
        sha: "abc123",
      },
    });

    const content = await readFile("memory/test.md", repo, owner);
    expect(content).toBe("Hello, World!");
    expect(mockGetContent).toHaveBeenCalledWith({
      owner,
      repo,
      path: "memory/test.md",
      ref: undefined,
    });
  });

  it("throws when target is a directory", async () => {
    mockGetContent.mockResolvedValue({
      data: [
        { name: "file1.md", type: "file", path: "memory/file1.md" },
        { name: "file2.md", type: "file", path: "memory/file2.md" },
      ],
    });

    await expect(
      readFile("memory/subdir", repo, owner)
    ).rejects.toThrow("is a directory");
  });

  it("throws when file is not found", async () => {
    const notFoundError = new Error("Not Found") as Error & { status: number };
    notFoundError.status = 404;
    mockGetContent.mockRejectedValue(notFoundError);

    await expect(
      readFile("memory/nonexistent.md", repo, owner)
    ).rejects.toThrow("File not found");
  });

  it("throws when file is too large", async () => {
    mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        name: "large.md",
        path: "memory/large.md",
        size: 2_000_000,
        encoding: "base64",
        content: "dG9vIGJpZw==",
        sha: "abc123",
      },
    });

    await expect(readFile("memory/large.md", repo, owner)).rejects.toThrow(
      "too large"
    );
  });
});
