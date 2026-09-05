import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerSliceJumpHandler,
  requestSliceJump,
  takePendingSliceJump,
  resetSliceJumpForTests,
} from "@/lib/chat/slice-jump";

describe("slice-jump bus", () => {
  beforeEach(() => resetSliceJumpForTests());

  it("runs the registered handler synchronously and reports handled", () => {
    const handler = vi.fn();
    const unregister = registerSliceJumpHandler(handler);
    expect(requestSliceJump("2026-08-01-1000")).toBe(true);
    expect(handler).toHaveBeenCalledWith("2026-08-01-1000");
    // Nothing stashed when handled.
    expect(takePendingSliceJump()).toBeNull();
    unregister();
  });

  it("stashes the jump when no handler is registered (palette on another route)", () => {
    expect(requestSliceJump("2026-08-01-1000")).toBe(false);
    expect(takePendingSliceJump()).toBe("2026-08-01-1000");
    // The stash is consumed by the take.
    expect(takePendingSliceJump()).toBeNull();
  });

  it("the latest unhandled jump wins", () => {
    requestSliceJump("2026-08-01-1000");
    requestSliceJump("2026-08-02-1100");
    expect(takePendingSliceJump()).toBe("2026-08-02-1100");
  });

  it("unregistering detaches only its own handler", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregA = registerSliceJumpHandler(a);
    registerSliceJumpHandler(b);
    unregA(); // stale unregister must not detach b
    expect(requestSliceJump("2026-08-03-1200")).toBe(true);
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
});
