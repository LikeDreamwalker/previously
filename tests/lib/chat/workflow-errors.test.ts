import { describe, it, expect } from "vitest";
import {
  classifyWorkflowError,
  errorMessage,
  formatErrorDetail,
} from "@/lib/chat/workflow-errors";

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

describe("formatErrorDetail", () => {
  it("captures name, message and stack", () => {
    const e = new Error("boom");
    const out = formatErrorDetail(e);
    expect(out).toContain("name=Error");
    expect(out).toContain("message=boom");
    expect(out).toContain("stack=Error: boom");
  });

  it("captures provider SDK fields (statusCode / requestId / code)", () => {
    const e = new Error("Invalid API key") as Error & Record<string, unknown>;
    e.name = "AI_APICallError";
    e.statusCode = 401;
    e.requestId = "req_123";
    e.code = "unauthorized";
    const out = formatErrorDetail(e);
    expect(out).toContain("name=AI_APICallError");
    expect(out).toContain("statusCode=401");
    expect(out).toContain("requestId=req_123");
    expect(out).toContain("code=unauthorized");
  });

  it("recurses the cause chain", () => {
    const outer = new Error("wrapped") as Error & { cause?: unknown };
    outer.cause = new Error("root cause");
    const out = formatErrorDetail(outer);
    expect(out).toContain("cause:");
    expect(out).toContain("message=root cause");
  });

  it("bounds the cause-chain depth", () => {
    let current: Error & { cause?: unknown } = new Error("deep-6");
    for (let i = 0; i < 10; i++) {
      const next = new Error(`deep-${i}`) as Error & { cause?: unknown };
      next.cause = current;
      current = next;
    }
    const out = formatErrorDetail(current);
    // MAX_CAUSE_DEPTH = 5 → exactly 5 `cause:` blocks (depths 0..4).
    expect(out.match(/cause:/g)?.length).toBe(5);
  });

  it("captures JSON-serializable extra own properties", () => {
    const e = new Error("x") as Error & Record<string, unknown>;
    e.responseBody = { message: "quota exceeded" };
    const out = formatErrorDetail(e);
    expect(out).toContain('responseBody={"message":"quota exceeded"}');
  });

  it("handles non-Error values without crashing", () => {
    expect(formatErrorDetail(null)).toBe("(no error value)");
    expect(formatErrorDetail(undefined)).toBe("(no error value)");
    expect(formatErrorDetail("plain string")).toBe("plain string");
    expect(formatErrorDetail(42)).toBe("42");
  });

  it("marks anonymous / empty errors readably", () => {
    const out = formatErrorDetail({});
    expect(out).toContain("name=(anonymous error)");
  });

  it("does not throw on circular extra properties", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const e = new Error("x") as Error & Record<string, unknown>;
    e.meta = circular;
    expect(() => formatErrorDetail(e)).not.toThrow();
  });
});
