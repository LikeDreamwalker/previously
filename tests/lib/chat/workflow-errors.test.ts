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
    expect(classifyWorkflowError(new Error("Step timed out: deadline exceeded")).kind).toBe(
      "timeout",
    );
  });

  it("classifies timeout error NAMES as timeout", () => {
    expect(classifyWorkflowError(namedError("TimeoutError")).kind).toBe("timeout");
    expect(classifyWorkflowError(namedError("StepTimeoutError")).kind).toBe("timeout");
  });

  it("classifies transient infra messages as transient", () => {
    expect(classifyWorkflowError(new Error("ECONNRESET socket hang up")).kind).toBe(
      "transient",
    );
  });

  it("defaults unknown agent-loop errors to TERMINAL (surface, don't burn continuations)", () => {
    const c = classifyWorkflowError(new Error("some unclassifiable error"));
    expect(c.kind).toBe("terminal");
    expect(c.userMessage).toBeTruthy();
  });

  it("handles null / non-Error values", () => {
    expect(classifyWorkflowError(null).kind).toBe("terminal");
    expect(classifyWorkflowError("string error").kind).toBe("terminal");
  });

  // ── Structured-evidence table (C1) ────────────────────────────────────────
  describe("structured statusCode evidence", () => {
    function apiError(statusCode: number, message = "API call failed"): Error {
      const e = new Error(message) as Error & { statusCode?: number };
      e.name = "AI_APICallError";
      e.statusCode = statusCode;
      return e;
    }

    it.each([
      [500, "transient"],
      [502, "transient"],
      [503, "transient"],
      [429, "transient"],
      [409, "transient"],
      [408, "timeout"],
      [400, "model"],
      [401, "model"],
      [403, "model"],
      [404, "model"],
    ] as const)("APICallError statusCode=%i → %s", (statusCode, kind) => {
      expect(classifyWorkflowError(apiError(statusCode)).kind).toBe(kind);
    });

    it("model-classified 4xx carries a user message", () => {
      const c = classifyWorkflowError(apiError(401, "Invalid API key"));
      expect(c.kind).toBe("model");
      expect(c.userMessage).toContain("The model call failed");
    });
  });

  it("classifies AI_RetryError as transient (queue redelivers)", () => {
    expect(classifyWorkflowError(namedError("AI_RetryError", "retries exhausted")).kind).toBe(
      "transient",
    );
  });

  it("does NOT classify a real GitHub-404 text as a model failure", () => {
    // The old MODEL_RE matched the bare "404" in any message — a missing file
    // read or a tool's fetch would be misreported as a model/auth failure.
    const github404 = new Error(
      "Not Found - https://api.github.com/repos/o/r/contents/memory/episodic/slices/2026/08/16 (404)",
    );
    expect(classifyWorkflowError(github404).kind).not.toBe("model");
    // Octokit-style errors carry `status` (not `statusCode`) — deliberately
    // not treated as provider evidence.
    const octokit404 = Object.assign(new Error("Not Found"), { status: 404 });
    expect(classifyWorkflowError(octokit404).kind).not.toBe("model");
  });

  it("no longer treats bare 400 text as a model failure", () => {
    const c = classifyWorkflowError(new Error("Request failed with status 400 from example.com"));
    expect(c.kind).not.toBe("model");
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
