import { describe, it, expect, vi, afterEach } from "vitest";

// runRecallSearch runs on the unified sub-agent runner — mock it so tests
// drive structured runner results instead of real model calls. fsReadFile is
// stubbed so the per-run catalog load fails closed (validSliceIds = null,
// meaning "skip hallucination filtering").
const runner = vi.hoisted(() => ({ runSubAgent: vi.fn() }));
vi.mock("@/lib/agents/sub-agent-runner", () => ({
  runSubAgent: runner.runSubAgent,
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async () => {
    throw new Error("no catalog in tests");
  }),
}));

import {
  prepareRecallStep,
  paginateTimelineEntries,
  paginateTimelineMarkdown,
  filterKnownSliceIds,
  excludeCurrentSlice,
  runRecallSearch,
  MAX_STEPS,
} from "@/lib/episodic/flash/recall";
import type { ModelConfig } from "@/lib/models/registry";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const testModel: ModelConfig = {
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: true,
  defaultEffort: "medium",
};

function recallInput(query = "q") {
  return {
    query,
    currentSliceId: "2026-08-05-1644",
    owner: "o",
    repo: "r",
    useGithub: false,
    useDemo: false,
    model: testModel,
  };
}

function entry(id: string): TimelineSliceEntry {
  return {
    id,
    date: id.slice(0, 10),
    start: "",
    status: "closed",
    focus: `focus ${id}`,
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
  };
}

describe("prepareRecallStep", () => {
  it("leaves toolChoice alone while budget remains", () => {
    expect(prepareRecallStep({ steps: [] })).toBeUndefined();
    expect(
      prepareRecallStep({
        steps: [{ toolCalls: [{ toolName: "readGlobalTimeline" }] }],
      }),
    ).toBeUndefined();
  });

  it("forces recallReport on the final step when it has not been called", () => {
    const steps = Array.from({ length: MAX_STEPS - 1 }, () => ({
      toolCalls: [{ toolName: "readStrand" }],
    }));
    expect(prepareRecallStep({ steps })).toEqual({
      toolChoice: { type: "tool", toolName: "recallReport" },
    });
  });

  it("does not force recallReport once it has been called", () => {
    const steps = [
      ...Array.from({ length: MAX_STEPS - 2 }, () => ({
        toolCalls: [{ toolName: "readStrand" }],
      })),
      { toolCalls: [{ toolName: "recallReport" }] },
    ];
    expect(prepareRecallStep({ steps })).toBeUndefined();
  });

  it("respects a custom maxSteps", () => {
    const steps = [
      { toolCalls: [{ toolName: "readGlobalTimeline" }] },
      { toolCalls: [{ toolName: "readStrand" }] },
    ];
    expect(prepareRecallStep({ steps, maxSteps: 3 })).toEqual({
      toolChoice: { type: "tool", toolName: "recallReport" },
    });
    expect(prepareRecallStep({ steps, maxSteps: 8 })).toBeUndefined();
  });

  it("handles steps without toolCalls", () => {
    const steps = Array.from({ length: MAX_STEPS - 1 }, () => ({}));
    expect(prepareRecallStep({ steps })).toEqual({
      toolChoice: { type: "tool", toolName: "recallReport" },
    });
  });
});

describe("paginateTimelineEntries", () => {
  it("returns at most 40 pointer lines, newest first, plus a header", () => {
    // 45 slices across two days, ids increasing with recency
    const slices = Array.from({ length: 45 }, (_, i) =>
      entry(`2026-08-${String(1 + (i % 2)).padStart(2, "0")}-${String(1000 + i)}`),
    );
    const out = paginateTimelineEntries(slices);
    const lines = out.split("\n");

    expect(lines).toHaveLength(41); // 1 header + 40 pointer lines
    expect(lines[0]).toContain("newest 40 of 45 slices");
    expect(lines[0]).toContain("readTimelineWindow");

    const pointerLines = lines.slice(1);
    expect(pointerLines.every((l) => l.startsWith("- **"))).toBe(true);
    const ids = pointerLines.map((l) => l.match(/\*\*(.+?)\*\*/)![1]);
    const sorted = [...ids].sort((a, b) => b.localeCompare(a));
    expect(ids).toEqual(sorted); // newest first
    expect(ids[0]).toBe("2026-08-02-1043"); // newest id in the set
  });

  it("returns everything when there are fewer slices than the page size", () => {
    const slices = [entry("2026-08-01-1000"), entry("2026-08-01-1100")];
    const lines = paginateTimelineEntries(slices).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("newest 2 of 2 slices");
    expect(lines[1]).toContain("2026-08-01-1100");
    expect(lines[2]).toContain("2026-08-01-1000");
  });

  it("reports an empty timeline", () => {
    expect(paginateTimelineEntries([])).toBe("(timeline is empty — no slices yet)");
  });
});

describe("paginateTimelineMarkdown", () => {
  it("keeps only the newest pointer lines and adds a header", () => {
    const pointer = (id: string) => `- **${id}** focus ${id} [tag]`;
    // timeline.md is rendered newest-first
    const ids = Array.from({ length: 50 }, (_, i) => `2026-08-01-${String(2000 - i)}`);
    const md = [
      "# Timeline",
      "",
      "_Generated: 2026-08-16T00:00:00.000Z_",
      "",
      "## 2026-08",
      ...ids.map(pointer),
    ].join("\n");

    const lines = paginateTimelineMarkdown(md).split("\n");
    expect(lines).toHaveLength(41);
    expect(lines[0]).toContain("newest 40 of 50 slices");
    expect(lines[0]).toContain("readTimelineWindow");
    expect(lines[1]).toContain("2026-08-01-2000"); // first pointer = newest
    expect(lines[40]).toContain("2026-08-01-1961");
    expect(lines.some((l) => l.startsWith("#") || l.startsWith("_"))).toBe(false);
  });

  it("reports an empty timeline when there are no pointer lines", () => {
    expect(paginateTimelineMarkdown("# Timeline\n\n_Generated: x_\n")).toBe(
      "(timeline is empty — no slices yet)",
    );
  });
});

describe("filterKnownSliceIds", () => {
  it("drops hallucinated slice ids and logs them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = new Set(["2026-08-01-1000", "2026-08-02-1100"]);
    const hits = [
      { slice_id: "2026-08-01-1000", relevance: 0.9, reason: "real" },
      { slice_id: "2026-08-01-9999", relevance: 0.8, reason: "hallucinated" },
    ];
    const result = filterKnownSliceIds(hits, valid);
    expect(result.map((h) => h.slice_id)).toEqual(["2026-08-01-1000"]);
    expect(warn).toHaveBeenCalledWith(
      "[Recall] Dropping hallucinated slice id: 2026-08-01-9999",
    );
  });

  it("passes everything through when the catalog is unreadable (null)", () => {
    const hits = [{ slice_id: "anything-goes", relevance: 0.5, reason: "x" }];
    expect(filterKnownSliceIds(hits, null)).toEqual(hits);
  });
});

describe("recall result pipeline", () => {
  it("excludes the current slice, then drops hallucinated ids", () => {
    const valid = new Set(["2026-08-01-1000", "2026-08-05-1644"]);
    const rawHits = [
      { slice_id: "2026-08-01-1000", relevance: 0.9, reason: "past" },
      { slice_id: "2026-08-05-1644", relevance: 0.8, reason: "current" },
      { slice_id: "2026-07-01-0000", relevance: 0.7, reason: "hallucinated" },
    ];
    const result = filterKnownSliceIds(
      excludeCurrentSlice(rawHits, "2026-08-05-1644"),
      valid,
    );
    expect(result.map((h) => h.slice_id)).toEqual(["2026-08-01-1000"]);
  });
});

// ─── runRecallSearch on the unified runner ──────────────────────────────

describe("runRecallSearch", () => {
  it("passes the shared-base system, dynamic user prompt, step cap and prepareStep to the runner", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: {
        hits: [],
        confidence: 0.5,
        reasoning: "nothing",
        recommended_reads: [],
      },
      text: "",
    });

    await runRecallSearch(recallInput("when did we discuss caching?"));

    expect(runner.runSubAgent).toHaveBeenCalledTimes(1);
    const opts = runner.runSubAgent.mock.calls[0]![0];
    expect(opts.model).toBe(testModel);
    expect(opts.system).toContain("recall search engine");
    expect(opts.system).toContain("sub-agent of the Previously memory system");
    expect(opts.prompt).toContain('Search query: "when did we discuss caching?"');
    expect(opts.prompt).toContain("2026-08-05-1644");
    expect(opts.prompt).not.toContain("sub-agent of the Previously");
    expect(opts.maxSteps).toBe(MAX_STEPS);
    expect(opts.timeoutMs).toBe(120_000);
    expect(opts.reportToolName).toBe("recallReport");
    expect(opts.prepareStep).toBe(prepareRecallStep);
    expect(Object.keys(opts.tools)).toEqual([
      "readGlobalTimeline",
      "readStrand",
      "readTimelineWindow",
      "recallReport",
    ]);
  });

  it("maps the report through the exclusion pipeline", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: {
        hits: [
          { slice_id: "2026-08-01-1000", relevance: 0.9, reason: "past match" },
          { slice_id: "2026-08-05-1644", relevance: 0.8, reason: "current" },
        ],
        confidence: 0.8,
        reasoning: "found things",
        recommended_reads: [
          { slice_id: "2026-08-01-1000", priority: "high", reason: "direct" },
        ],
      },
      text: "",
    });

    const out = await runRecallSearch(recallInput());
    expect(out.hits.map((h) => h.slice_id)).toEqual(["2026-08-01-1000"]);
    expect(out.recommendedReads).toEqual([
      { slice_id: "2026-08-01-1000", priority: "high", reason: "direct", note: undefined },
    ]);
    expect(out.reasoning).toContain("[Excluded current slice 2026-08-05-1644");
  });

  it("zeros confidence when the only hits were the current slice", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: {
        hits: [{ slice_id: "2026-08-05-1644", relevance: 0.9, reason: "self" }],
        confidence: 0.9,
        reasoning: "only itself",
        recommended_reads: [],
      },
      text: "",
    });
    const out = await runRecallSearch(recallInput());
    expect(out.hits).toEqual([]);
    expect(out.confidence).toBe(0);
  });

  it("falls back to the text fragment when recallReport was never called", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: true,
      report: undefined,
      text: "I could not find anything relevant",
    });
    const out = await runRecallSearch(recallInput());
    expect(out.hits).toEqual([]);
    expect(out.confidence).toBe(0);
    expect(out.reasoning).toContain("Model responded without calling recallReport");
  });

  it("degrades a timeout to an empty result instead of throwing", async () => {
    runner.runSubAgent.mockResolvedValue({
      ok: false,
      timedOut: true,
      text: "",
      error: "Sub-agent did not finish within 120s.",
    });
    const out = await runRecallSearch(recallInput());
    expect(out.hits).toEqual([]);
    expect(out.confidence).toBe(0);
    expect(out.reasoning).toContain("120s");
  });

  it("re-throws non-timeout failures so the executor can triage transient errors for step retry", async () => {
    // Transient (429) — must propagate: a catch-all here would swallow an
    // error the workflow step's auto-retry could fix.
    runner.runSubAgent.mockResolvedValue({
      ok: false,
      text: "",
      error: "HTTP 429 Too Many Requests",
    });
    await expect(runRecallSearch(recallInput())).rejects.toThrow(
      "HTTP 429 Too Many Requests",
    );

    // Deterministic failures also propagate — the EXECUTOR's triage
    // (tool-triage.ts) turns them into the empty-result degradation.
    runner.runSubAgent.mockResolvedValue({
      ok: false,
      text: "",
      error: "InvalidToolInputError: recallReport input failed validation",
    });
    await expect(runRecallSearch(recallInput())).rejects.toThrow(
      "InvalidToolInputError",
    );
  });
});
