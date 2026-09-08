import { describe, it, expect, vi, afterEach } from "vitest";

// searchViaFlash runs on the unified sub-agent runner — mock it so tests
// drive structured runner results instead of real model calls. The DeepSeek
// provider itself is constructed offline (no network), but we mock the
// Anthropic SDK factory so we can assert on the webSearch maxUses cap.
const runner = vi.hoisted(() => ({ runSubAgent: vi.fn() }));
vi.mock("@/lib/agents/sub-agent-runner", () => ({
  runSubAgent: runner.runSubAgent,
}));

const anthropic = vi.hoisted(() => {
  const modelFn = vi.fn(() => ({ __kind: "languageModel" }));
  const webSearchToolFn = vi.fn(() => ({ __tool: "web_search" }));
  const provider = Object.assign(modelFn, {
    tools: { webSearch_20260209: webSearchToolFn },
  });
  return {
    createAnthropic: vi.fn(() => provider),
    webSearchToolFn,
  };
});
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: anthropic.createAnthropic,
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
    expect(opts.maxSteps).toBe(50);
    expect(opts.timeoutMs).toBe(240_000);
    expect(opts.reportToolName).toBe("searchReport");
    // Static role in system; the date anchor and query moved to the user prompt.
    expect(opts.system).toContain("sub-agent of the Previously memory system");
    expect(opts.system).toContain("independent researcher");
    expect(opts.system).not.toContain("Today is");
    expect(opts.prompt).toMatch(/^Today is \d{4}-\d{2}-\d{2}\./);
    expect(opts.prompt).toContain("Query: latest Next.js version");
    expect(Object.keys(opts.tools).sort()).toEqual(["searchReport", "webFetch", "web_search"]);
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
      error: "Sub-agent did not finish within 240s.",
    });
    await expect(searchViaFlash("q")).rejects.toThrow(
      "Sub-agent did not finish within 240s.",
    );
  });

  it("recovers an interrupted run's partial text as a flagged low-confidence answer on timeout", async () => {
    // Aligned with recall's soft-timeout degradation: a cut-off research run
    // still hands back what it had written, instead of losing everything.
    runner.runSubAgent.mockResolvedValue({
      ok: false,
      timedOut: true,
      text: "The Next.js docs say the latest version is…",
      error: "Sub-agent did not finish within 240s.",
      sources: [{ sourceType: "url", url: "https://nextjs.org/docs", title: "Docs" }],
    });
    const out = await searchViaFlash("q");
    expect(out.answer).toContain("The Next.js docs say");
    expect(out.recommendation).toContain("time budget");
    expect(out.recommendation).toContain("lower-confidence");
    expect(out.suggestedReads).toEqual([]);
    expect(out.sources).toEqual([
      { title: "Docs", url: "https://nextjs.org/docs" },
    ]);
  });

  it("caps the researcher's own page reads at the per-run quota", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: { answer: "a", recommendation: "r", suggested_reads: [] },
      text: "",
    });
    await searchViaFlash("q");
    const opts = runner.runSubAgent.mock.calls[0]![0];
    const webFetch = opts.tools.webFetch as {
      execute: (input: { url: string }) => Promise<string>;
    };
    // Invalid URLs error before any network I/O — but still consume a slot.
    for (let i = 0; i < 6; i++) {
      const out = await webFetch.execute({ url: "not a url" });
      expect(out).toContain("ERROR: Invalid URL");
    }
    // Slot 7: quota exhausted — a note, no fetch attempted.
    const out = await webFetch.execute({ url: "https://example.com" });
    expect(out).toContain("Page-read quota exhausted");
  });

  it("uses standard-mode effective caps (6 pages / 3 search rounds) by default", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: { answer: "a", recommendation: "r", suggested_reads: [] },
      text: "",
    });
    await searchViaFlash("q");
    const opts = runner.runSubAgent.mock.calls[0]![0];

    expect(anthropic.webSearchToolFn).toHaveBeenCalledTimes(1);
    expect(anthropic.webSearchToolFn).toHaveBeenCalledWith({ maxUses: 3 });
    expect(opts.system).toContain("up to 3 search rounds");
    expect(opts.system).toContain("read at most 6 pages per run");
    expect(opts.tools.webFetch.description).toContain(
      "one of your 6 page-read slots",
    );
    expect(opts.prompt).not.toContain(
      "one of several researchers working in parallel",
    );
  });

  it("uses scout-mode effective caps (3 pages / 2 search rounds) when opts.scout is true", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: { answer: "a", recommendation: "r", suggested_reads: [] },
      text: "",
    });
    await searchViaFlash("q", undefined, undefined, { scout: true });
    const opts = runner.runSubAgent.mock.calls[0]![0];

    expect(anthropic.webSearchToolFn).toHaveBeenCalledTimes(1);
    expect(anthropic.webSearchToolFn).toHaveBeenCalledWith({ maxUses: 2 });
    expect(opts.system).toContain("up to 2 search rounds");
    expect(opts.system).toContain("read at most 3 pages per run");
    expect(opts.tools.webFetch.description).toContain(
      "one of your 3 page-read slots",
    );
    expect(opts.prompt).toContain(
      "You are one of several researchers working in parallel on different sub-questions",
    );
  });

  it("enforces the lower scout-mode page-read quota", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: { answer: "a", recommendation: "r", suggested_reads: [] },
      text: "",
    });
    await searchViaFlash("q", undefined, undefined, { scout: true });
    const opts = runner.runSubAgent.mock.calls[0]![0];
    const webFetch = opts.tools.webFetch as {
      execute: (input: { url: string }) => Promise<string>;
    };

    for (let i = 0; i < 3; i++) {
      const out = await webFetch.execute({ url: "not a url" });
      expect(out).toContain("ERROR: Invalid URL");
    }
    const out = await webFetch.execute({ url: "https://example.com" });
    expect(out).toContain("Page-read quota exhausted — 3 reads per run");
  });

  it("embeds query-planning discipline in the researcher role", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: { answer: "a", recommendation: "r", suggested_reads: [] },
      text: "",
    });
    await searchViaFlash("q");
    const opts = runner.runSubAgent.mock.calls[0]![0];

    expect(opts.system).toContain("Round 1 may use the query as-is");
    expect(opts.system).toContain(
      "every later round must either reformulate based on what you have learned or chase a new lead",
    );
    expect(opts.system).toContain(
      "Before issuing a new search round, state (in thinking) what is still missing",
    );
    expect(opts.system).toContain(
      "read the most promising pages with webFetch between rounds",
    );
  });
});
