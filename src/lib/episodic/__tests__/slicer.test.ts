import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkSliceAge, DEFAULT_MAX_SLICE_AGE_MS } from "../slicer";

describe("checkSliceAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when the slice just started", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(checkSliceAge(new Date(now).toISOString())).toBe(false);
  });

  it("returns false when the slice started 5 minutes ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    expect(checkSliceAge(fiveMinAgo)).toBe(false);
  });

  it("returns false exactly at the cap boundary minus 1ms", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const boundary = new Date(now - DEFAULT_MAX_SLICE_AGE_MS + 1).toISOString();
    expect(checkSliceAge(boundary)).toBe(false);
  });

  it("returns true exactly at the cap boundary", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const boundary = new Date(now - DEFAULT_MAX_SLICE_AGE_MS).toISOString();
    expect(checkSliceAge(boundary)).toBe(true);
  });

  it("returns true when well past the cap (1 hour)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    expect(checkSliceAge(oneHourAgo)).toBe(true);
  });

  it("returns true when days past the cap", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const daysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(checkSliceAge(daysAgo)).toBe(true);
  });

  it("handles a future start time (clock skew) — returns false", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const future = new Date(now + 60 * 1000).toISOString();
    expect(checkSliceAge(future)).toBe(false);
  });

  it("honours a custom cap", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    expect(checkSliceAge(tenMinAgo, 5 * 60 * 1000)).toBe(true);
    expect(checkSliceAge(tenMinAgo, 15 * 60 * 1000)).toBe(false);
  });

  it("default cap is exactly 30 minutes in milliseconds", () => {
    expect(DEFAULT_MAX_SLICE_AGE_MS).toBe(30 * 60 * 1000);
  });
});
