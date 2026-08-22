import { describe, it, expect, vi, afterEach } from "vitest";

// searchViaFlash runs on the unified sub-agent runner — mock it so tests
// drive structured runner results instead of real model calls. The DeepSeek
// provider itself is constructed offline (no network).
const runner = vi.hoisted(() => ({ runSubAgent: vi.fn() }));
vi.mock("@/lib/agents/sub-agent-runner", () => ({
  runSubAgent: runner.runSubAgent,
}));

import { searchViaFlash } from "@/lib/search/flash-search";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchViaFlash", () => {
  it("runs on the runner with a pre-built model, anthropic effort mapping, and the static/dynamic prompt split", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: { answer: "a", recommendation: "r", suggested_reads: [] },
      text: "",
    });

    await searchViaFlash("latest Next.js version");

    expect(runner.runSubAgent).toHaveBeenCalledTimes(1);
    const opts = runner.runSubAgent.mock.calls[0]![0];
    // The provider path is unchanged: a pre-built model on DeepSeek's
    // Anthropic-compatible endpoint — never a createModel(ModelConfig).
    expect(opts.languageModel).toBeDefined();
    expect(opts.model).toBeUndefined();
    expect(opts.effortSdk).toBe("anthropic");
    expect(opts.maxSteps).toBe(6);
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.reportToolName).toBe("searchReport");
    // Static role in system; the date anchor and query moved to the user prompt.
    expect(opts.system).toContain("sub-agent of the Previously memory system");
    expect(opts.system).toContain("video assistant (VAR)");
    expect(opts.system).not.toContain("Today is");
    expect(opts.prompt).toMatch(/^Today is \d{4}-\d{2}-\d{2}\./);
    expect(opts.prompt).toContain("Query: latest Next.js version");
    expect(Object.keys(opts.tools).sort()).toEqual(["searchReport", "web_search"]);
  });

  it("maps the searchReport into the neutral contract with url sources", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: {
        answer: "The answer.",
        recommendation: "Fetch the docs page.",
        suggested_reads: [
          { url: "https://example.com/a", title: "A", reason: "primary" },
          { url: "", title: "bad", reason: "no url" },
        ],
      },
      text: "",
      sources: [
        { sourceType: "url", url: "https://example.com/a", title: "A" },
        { sourceType: "document", title: "not a url" },
      ],
    });

    const out = await searchViaFlash("q");
    expect(out.answer).toBe("The answer.");
    expect(out.recommendation).toBe("Fetch the docs page.");
    expect(out.suggestedReads).toEqual([
      { url: "https://example.com/a", title: "A", reason: "primary" },
    ]);
    expect(out.sources).toEqual([{ title: "A", url: "https://example.com/a" }]);
  });

  it("falls back to the free-text answer when searchReport was never called", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: undefined,
      text: "plain answer text",
      sources: [],
    });
    const out = await searchViaFlash("q");
    expect(out).toEqual({
      answer: "plain answer text",
      recommendation: "",
      suggestedReads: [],
      sources: [],
    });
  });

  it("re-throws failed runs so the executor's triage keeps retry/error classification", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: false,
      text: "",
      error: "HTTP 429 Too Many Requests",
    });
    await expect(searchViaFlash("q")).rejects.toThrow(
      "HTTP 429 Too Many Requests",
    );

    runner.runSubAgent.mockResolvedValue({
      ok: false,
      timedOut: true,
      text: "",
      error: "Sub-agent did not finish within 60s.",
    });
    await expect(searchViaFlash("q")).rejects.toThrow(
      "Sub-agent did not finish within 60s.",
    );
  });
});
