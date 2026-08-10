import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import {
  readFile,
  invalidateReadCache,
  __resetReadCache,
} from "@/lib/tools/readFile";

const repo = "test-repo";
const owner = "test-owner";

function fileResponse(content: string) {
  return {
    data: {
      type: "file",
      name: "f.md",
      path: "memory/f.md",
      size: content.length,
      encoding: "base64",
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha: "abc123",
    },
  };
}

describe("readFile cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetReadCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves repeated reads of the same path from the cache", async () => {
    mockGetContent.mockResolvedValue(fileResponse("version one"));

    const first = await readFile("memory/f.md", repo, owner);
    const second = await readFile("memory/f.md", repo, owner);

    expect(first).toBe("version one");
    expect(second).toBe("version one");
    // One GitHub round-trip, not two.
    expect(mockGetContent).toHaveBeenCalledTimes(1);
  });

  it("caches per-path, not globally", async () => {
    mockGetContent.mockImplementation(async ({ path }: { path: string }) =>
      fileResponse(`content of ${path}`),
    );

    const a = await readFile("memory/a.md", repo, owner);
    const b = await readFile("memory/b.md", repo, owner);
    const aAgain = await readFile("memory/a.md", repo, owner);

    expect(a).toBe("content of memory/a.md");
    expect(b).toBe("content of memory/b.md");
    expect(aAgain).toBe(a);
    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });

  it("invalidating a path forces a fresh fetch", async () => {
    mockGetContent.mockResolvedValueOnce(fileResponse("old"));
    await readFile("memory/f.md", repo, owner);

    mockGetContent.mockResolvedValueOnce(fileResponse("new"));
    invalidateReadCache("memory/f.md", repo, owner);

    const fresh = await readFile("memory/f.md", repo, owner);
    expect(fresh).toBe("new");
    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });

  it("expires cached entries after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    mockGetContent.mockResolvedValueOnce(fileResponse("before ttl"));
    await readFile("memory/f.md", repo, owner);

    mockGetContent.mockResolvedValueOnce(fileResponse("after ttl"));
    vi.advanceTimersByTime(61_000);

    const fresh = await readFile("memory/f.md", repo, owner);
    expect(fresh).toBe("after ttl");
    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });

  it("does not cache errors, so a later success re-fetches", async () => {
    const notFoundError = new Error("Not Found") as Error & { status: number };
    notFoundError.status = 404;

    mockGetContent.mockRejectedValueOnce(notFoundError);
    await expect(
      readFile("memory/f.md", repo, owner)
    ).rejects.toThrow("File not found");

    mockGetContent.mockResolvedValueOnce(fileResponse("now exists"));
    const content = await readFile("memory/f.md", repo, owner);

    expect(content).toBe("now exists");
    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });

  it("__resetReadCache forces a re-fetch", async () => {
    mockGetContent.mockResolvedValueOnce(fileResponse("cached"));
    await readFile("memory/f.md", repo, owner);

    mockGetContent.mockResolvedValueOnce(fileResponse("reset"));
    __resetReadCache();

    const fresh = await readFile("memory/f.md", repo, owner);
    expect(fresh).toBe("reset");
    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });
});
