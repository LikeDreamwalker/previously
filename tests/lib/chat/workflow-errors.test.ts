import { describe, it, expect } from "vitest";
import { classifyWorkflowError, errorMessage } from "@/lib/chat/workflow-errors";

/** Build a bare error with an overridden name + optional code/status. */
function namedError(
  name: string,
  message = "boom",
  extra: { code?: string; status?: number } = {},
): Error {
  const e = new Error(message);
  e.name = name;
  if (extra.code !== undefined) (e as Error & { code?: string }).code = extra.code;
  if (extra.status !== undefined) (e as Error & { status?: number }).status = extra.status;
  return e;
}

describe("classifyWorkflowError", () => {
  it("classifies AbortError as abort", () => {
    expect(classifyWorkflowError(namedError("AbortError")).kind).toBe("abort");
  });

  it("classifies ThrottleError as transient", () => {
    expect(classifyWorkflowError(namedError("ThrottleError", "429")).kind).toBe(
      "transient",
    );
  });

  it("classifies WorkflowWorldError status>=500 as transient", () => {
    expect(
      classifyWorkflowError(namedError("WorkflowWorldError", "server", { status: 503 })).kind,
    ).toBe("transient");
  });

  it("classifies WorkflowWorldError transport codes as transient", () => {
    expect(
      classifyWorkflowError(namedError("WorkflowWorldError", "x", { code: "TRANSPORT" })).kind,
    ).toBe("transient");
    expect(
      classifyWorkflowError(namedError("WorkflowWorldError", "x", { code: "TIMEOUT" })).kind,
    ).toBe("transient");
  });

  it("classifies WorkflowWorldError contract codes as terminal with a user message", () => {
    const c = classifyWorkflowError(
      namedError("WorkflowWorldError", "x", { code: "SCHEMA_VALIDATION" }),
    );
    expect(c.kind).toBe("terminal");
    expect(c.userMessage).toBeTruthy();
  });

  it("classifies corrupted-log / not-registered / decryption errors as terminal", () => {
    for (const name of [
      "CorruptedEventLogError",
      "StepNotRegisteredError",
      "WorkflowNotRegisteredError",
      "RuntimeDecryptionError",
    ]) {
      const c = classifyWorkflowError(namedError(name));
      expect(c.kind).toBe("terminal");
      expect(c.userMessage).toBeTruthy();
    }
  });

  it("classifies ReplayDivergenceError as transient", () => {
    expect(classifyWorkflowError(namedError("ReplayDivergenceError")).kind).toBe(
      "transient",
    );
  });

  it("classifies expired/not-found runs as terminal with a user message", () => {
    for (const name of ["RunExpiredError", "WorkflowRunNotFoundError", "WorkflowRunCancelledError"]) {
      const c = classifyWorkflowError(namedError(name));
      expect(c.kind).toBe("terminal");
      expect(c.userMessage).toBeTruthy();
    }
  });

  it("classifies model/provider failures as model with a user message", () => {
    const c = classifyWorkflowError(new Error("Invalid API key provided"));
    expect(c.kind).toBe("model");
    expect(c.userMessage).toBeTruthy();
  });

  it("classifies explicit timeout signals as timeout", () => {
    expect(classifyWorkflowError(new Error("FUNCTION_INVOCATION_TIMEOUT")).kind).toBe(
      "timeout",
    );
    expect(classifyWorkflowError(new Error("Step exceeded the time limit")).kind).toBe(
      "timeout",
    );
  });

  it("classifies transient infra messages as transient", () => {
    expect(classifyWorkflowError(new Error("ECONNRESET socket hang up")).kind).toBe(
      "transient",
    );
  });

  it("defaults unknown agent-loop errors to timeout (the dominant cause is a killed step)", () => {
    expect(classifyWorkflowError(new Error("some unclassifiable error")).kind).toBe(
      "timeout",
    );
  });

  it("handles null / non-Error values", () => {
    expect(classifyWorkflowError(null).kind).toBe("terminal");
    expect(classifyWorkflowError("string error").kind).toBe("timeout");
  });
});

describe("errorMessage", () => {
  it("extracts a readable message from any thrown value", () => {
    expect(errorMessage(new Error("x"))).toBe("x");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});
