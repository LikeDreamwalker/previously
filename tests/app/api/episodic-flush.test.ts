import { describe, it, expect, beforeEach, vi } from "vitest";

// Route-level test with the I/O seams mocked, mirroring
// tests/app/api/chat/chat.test.ts: we cover the route's own responsibility
// (guard + validation + write-target constraint), not the storage backends.

const mockReadFileLocal = vi.fn();
const mockWriteFileLocal = vi.fn();

vi.mock("@/lib/tools", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: (...args: unknown[]) => mockReadFileLocal(...args),
  writeFileLocal: (...args: unknown[]) => mockWriteFileLocal(...args),
}));
vi.mock("@/lib/capabilities", () => ({
  isDemo: () => false,
  getRepoConfig: () => ({ owner: "o", repo: "r" }),
}));
vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: () => "local",
  isDemo: () => false,
}));

import { POST } from "@/app/api/episodic/flush/route";

function flushReq(body: unknown): Request {
  return new Request("http://localhost:3000/api/episodic/flush", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const aTurn = { role: "user", content: "hello", timestamp: "2026-07-10T14:30:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  // Slice file does not exist yet → route builds fresh frontmatter.
  mockReadFileLocal.mockRejectedValue(new Error("ENOENT"));
  mockWriteFileLocal.mockResolvedValue(undefined);
});

describe("POST /api/episodic/flush validation", () => {
  it("rejects a non-slice-id string", async () => {
    const res = await POST(flushReq({ sliceId: "not-a-slice", turns: [aTurn] }));
    expect(res.status).toBe(400);
    expect(mockWriteFileLocal).not.toHaveBeenCalled();
  });

  it("rejects path-traversal sliceIds", async () => {
    const res = await POST(
      flushReq({ sliceId: "../../../../etc/passwd", turns: [aTurn] })
    );
    expect(res.status).toBe(400);
    expect(mockWriteFileLocal).not.toHaveBeenCalled();
  });

  it("rejects date-only ids (strict YYYY-MM-DD-HHMM required)", async () => {
    const res = await POST(flushReq({ sliceId: "2026-07-10", turns: [aTurn] }));
    expect(res.status).toBe(400);
    expect(mockWriteFileLocal).not.toHaveBeenCalled();
  });

  it("rejects more than 50 turns", async () => {
    const turns = Array.from({ length: 51 }, () => aTurn);
    const res = await POST(flushReq({ sliceId: "2026-07-10-1430", turns }));
    expect(res.status).toBe(400);
    expect(mockWriteFileLocal).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 turns", async () => {
    const turns = Array.from({ length: 50 }, () => aTurn);
    const res = await POST(flushReq({ sliceId: "2026-07-10-1430", turns }));
    expect(res.status).toBe(200);
  });

  it("writes only the target slice's timeline/core.md", async () => {
    const res = await POST(flushReq({ sliceId: "2026-07-10-1430", turns: [aTurn] }));
    expect(res.status).toBe(200);
    expect(mockWriteFileLocal).toHaveBeenCalledTimes(1);
    const [path] = mockWriteFileLocal.mock.calls[0];
    expect(path).toBe("memory/episodic/slices/2026/07/10/1430/timeline/core.md");
  });
});
