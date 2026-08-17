/**
 * Tests for the in-process per-slice mutex (B2) — same key serializes,
 * different keys run concurrently, a failing holder releases the queue.
 */
import { describe, it, expect } from "vitest";
import { withSliceLock } from "@/lib/episodic/slice-mutex";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withSliceLock", () => {
  it("serializes calls with the same key in arrival order", async () => {
    const order: string[] = [];
    const gate = deferred<void>();

    const first = withSliceLock("slice-1", async () => {
      await gate.promise;
      order.push("first");
    });
    const second = withSliceLock("slice-1", async () => {
      order.push("second");
    });

    // Give the microtask queue a turn — second must NOT have run yet.
    await Promise.resolve();
    expect(order).toEqual([]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs different keys concurrently", async () => {
    const gate = deferred<void>();
    let bRan = false;

    const a = withSliceLock("slice-a", async () => {
      await gate.promise;
    });
    const b = withSliceLock("slice-b", async () => {
      bRan = true;
    });

    await b;
    expect(bRan).toBe(true);
    gate.resolve();
    await a;
  });

  it("releases the queue when the holder rejects", async () => {
    await expect(
      withSliceLock("slice-x", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The next holder runs despite the failure.
    await expect(withSliceLock("slice-x", async () => 42)).resolves.toBe(42);
  });

  it("returns the fn result", async () => {
    await expect(withSliceLock("k", async () => "value")).resolves.toBe("value");
  });
});
