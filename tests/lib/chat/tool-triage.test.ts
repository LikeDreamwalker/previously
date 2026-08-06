import { describe, it, expect } from "vitest";
import { isTransientError, triageErrorMessage } from "@/lib/chat/tool-triage";

describe("isTransientError", () => {
  it("classifies network/timeout errors as transient", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("ETIMEDOUT reading api"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("HTTP 503 service unavailable"))).toBe(true);
    expect(isTransientError(new Error("429 too many requests"))).toBe(true);
  });

  it("classifies deterministic errors as non-transient", () => {
    expect(isTransientError(new Error("File not found: core.md"))).toBe(false);
    expect(isTransientError(new Error("Invalid argument"))).toBe(false);
    expect(isTransientError(new Error("config is wrong"))).toBe(false);
  });

  it("treats non-Error values as non-transient", () => {
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe("triageErrorMessage", () => {
  it("builds a model-facing message for a deterministic failure", () => {
    const msg = triageErrorMessage(
      new Error("File not found"),
      "readSlice",
    );
    expect(msg).toContain("[readSlice unavailable]");
    expect(msg).toContain("File not found");
    expect(msg).toContain("deterministic failure");
    expect(msg).toContain("retrying will not help");
  });

  it("notes when a failure looks transient and retryable", () => {
    const msg = triageErrorMessage(
      new Error("socket hang up"),
      "webSearch",
    );
    expect(msg).toContain("transient");
    expect(msg).toContain("you may retry once");
  });
});
