import { describe, it, expect, beforeEach, vi } from "vitest";

// The route is now a thin durable-turn launcher: parse + validate, hand off to
// startTurn (which starts the Workflow run), and stream the run back with the
// reconnect header. We mock at that seam — startTurn — so this unit test covers
// exactly the route's own responsibility, not the step/workflow machinery
// (which is exercised by steps.test.ts and, end to end, by the running app).

const mockStartTurn = vi.fn();

vi.mock("@/app/api/chat/start-turn", () => ({
  startTurn: (args: unknown) => mockStartTurn(args),
}));

vi.mock("ai", () => ({
  createUIMessageStreamResponse: vi.fn(
    ({ headers }: { stream: unknown; headers?: Record<string, string> }) =>
      new Response("mocked-ui-stream", {
        headers: { "Content-Type": "text/event-stream", ...(headers ?? {}) },
      })
  ),
}));

import { POST } from "@/app/api/chat/route";

function createRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartTurn.mockResolvedValue({
    runId: "wrun_test123",
    readable: new ReadableStream(),
  });
});

describe("POST /api/chat validation", () => {
  it("rejects empty messages array", async () => {
    const res = await POST(createRequest({ messages: [] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("must not be empty");
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it("rejects missing messages field", async () => {
    const res = await POST(createRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("required");
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat durable turn", () => {
  it("returns 200 streaming with the workflow run-id header", async () => {
    const res = await POST(
      createRequest({ messages: [{ role: "user", content: "hello" }] })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("x-workflow-run-id")).toBe("wrun_test123");
    expect(mockStartTurn).toHaveBeenCalledTimes(1);
  });

  it("forwards model and timezone to startTurn (thinking/effort are pinned server-side)", async () => {
    await POST(
      createRequest({
        messages: [{ role: "user", content: "hi" }],
        model: "deepseek-v4-pro",
        // thinking/effort in the body are deliberately ignored — startTurn
        // pins thinking ON at low effort regardless of the client.
        thinking: false,
        effort: "high",
        timezone: "Asia/Shanghai",
      })
    );
    const call = mockStartTurn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      model: "deepseek-v4-pro",
      timezone: "Asia/Shanghai",
    });
    expect(call.thinking).toBeUndefined();
    expect(call.effort).toBeUndefined();
  });

  it("omits optional overrides when not provided (config defaults apply downstream)", async () => {
    await POST(
      createRequest({ messages: [{ role: "user", content: "hi" }] })
    );
    expect(mockStartTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        timezone: undefined,
      })
    );
  });
});
