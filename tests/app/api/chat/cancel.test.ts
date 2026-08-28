import { describe, it, expect, vi, beforeEach } from "vitest";

// The workflow runtime is mocked at the api boundary — the cancel endpoint
// only ever touches getRun().status / run.cancel().
const workflowApi = vi.hoisted(() => ({
  getRun: vi.fn(),
}));
vi.mock("workflow/api", () => ({ getRun: workflowApi.getRun }));

// The origin guard is exercised in its own tests; here it always passes.
vi.mock("@/lib/security/origin-guard", () => ({ guardRequest: () => null }));

import { POST } from "@/app/api/chat/[runId]/cancel/route";

function call(runId: string) {
  return POST(new Request("http://localhost/api/chat/x/cancel", { method: "POST" }), {
    params: Promise.resolve({ runId }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/chat/[runId]/cancel", () => {
  it("cancels a running run", async () => {
    const cancel = vi.fn(async () => {});
    workflowApi.getRun.mockReturnValue({ status: Promise.resolve("running"), cancel });
    const res = await call("run_1");
    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });

  it("cancels a pending run too", async () => {
    const cancel = vi.fn(async () => {});
    workflowApi.getRun.mockReturnValue({ status: Promise.resolve("pending"), cancel });
    const res = await call("run_2");
    expect(cancel).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });

  it("is a no-op on a terminal run (the stop raced the run's own completion)", async () => {
    const cancel = vi.fn(async () => {});
    workflowApi.getRun.mockReturnValue({ status: Promise.resolve("completed"), cancel });
    const res = await call("run_3");
    expect(cancel).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, cancelled: false, status: "completed" });
  });

  it("a gone run resolves as a quiet no-op, never an error", async () => {
    workflowApi.getRun.mockImplementation(() => {
      throw new Error("run not found");
    });
    const res = await call("run_4");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: false, status: "gone" });
  });
});
