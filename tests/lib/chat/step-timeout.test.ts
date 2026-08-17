import { describe, it, expect, vi, afterEach } from "vitest";
import { withStepTimeout, StepTimeoutError } from "@/lib/chat/step-timeout";

describe("withStepTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result when work completes before the deadline", async () => {
    const result = await withStepTimeout(async () => "done", 1_000);
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.result).toBe("done");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns timedOut=true when work exceeds the deadline", async () => {
    vi.useFakeTimers();
    // Never settles — the timer must win the race.
    const pending = withStepTimeout(() => new Promise<string>(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.result).toBeUndefined();
  });

  it("calls onTimeout for partial text when the deadline hits", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => "partial report");
    const pending = withStepTimeout(
      () => new Promise<string>(() => {}),
      100,
      onTimeout,
    );
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.partialText).toBe("partial report");
  });

  it("does not call onTimeout on a fast success", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => "partial");
    const pending = withStepTimeout(async () => "fast", 1_000, onTimeout);
    // Flush microtasks without advancing the clock to the deadline.
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.result).toBe("fast");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("reports elapsedMs on a timeout", async () => {
    vi.useFakeTimers();
    const pending = withStepTimeout(() => new Promise<string>(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.elapsedMs).toBe(100);
  });

  it("re-throws non-timeout errors", async () => {
    await expect(
      withStepTimeout(async () => {
        throw new Error("boom");
      }, 1_000),
    ).rejects.toThrow("boom");
  });

  it("distinguishes StepTimeoutError as an internal marker", () => {
    const err = new StepTimeoutError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StepTimeoutError");
  });

  it("clears the pending timer after a fast success", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const result = await withStepTimeout(async () => "ok", 10_000);
    expect(result.ok).toBe(true);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("withStepTimeout cancellation (C3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the signal when the deadline hits", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const pending = withStepTimeout(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve("stopped-early");
          });
        }),
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(observedAbort).toBe(true);
  });

  it("does not abort the signal on a fast success", async () => {
    let captured: AbortSignal | null = null;
    const result = await withStepTimeout(async (signal) => {
      captured = signal;
      return "done";
    }, 1_000);

    expect(result.ok).toBe(true);
    expect(captured!.aborted).toBe(false);
  });

  it("lets the loser check signal.aborted to skip a late commit", async () => {
    vi.useFakeTimers();
    let committed = false;
    const pending = withStepTimeout(async (signal) => {
      await new Promise((r) => setTimeout(r, 500));
      if (signal.aborted) throw new Error("aborted — write skipped");
      committed = true;
      return "committed";
    }, 100);

    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.timedOut).toBe(true);

    // Let the loser finish — it must observe the abort and skip its write.
    await vi.advanceTimersByTimeAsync(500);
    expect(committed).toBe(false);
  });
});
