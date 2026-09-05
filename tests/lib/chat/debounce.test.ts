import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDebounced } from "@/lib/chat/debounce";

describe("createDebounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once on the trailing edge with the LATEST args", () => {
    const fn = vi.fn();
    const d = createDebounced(fn, 250);
    d.call("a");
    d.call("ab");
    d.call("abc");
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("abc");
  });

  it("fires again after a quiet period", () => {
    const fn = vi.fn();
    const d = createDebounced(fn, 100);
    d.call(1);
    vi.advanceTimersByTime(100);
    d.call(2);
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([[1], [2]]);
  });

  it("cancel drops a pending call (unmount safety)", () => {
    const fn = vi.fn();
    const d = createDebounced(fn, 100);
    d.call("x");
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
