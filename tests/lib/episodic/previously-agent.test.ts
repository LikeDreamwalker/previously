/**
 * previously-agent — the Previously Agent on the shared sub-agent runner.
 * The contract that matters: a clean finish returns the evolved card; a pass
 * that exhausts its steps WITHOUT finish returns a PARTIAL card (mutations
 * kept) instead of failing; only a hard failure retries (once, at a higher
 * temperature that breaks deterministic re-submission loops) and then fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runPreviouslyAgent,
  type PreviouslyAgentInput,
} from "@/lib/episodic/flash/previously-agent";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import {
  newCardTemplate,
  parseCard,
  CARD_PROFILE_MAX_CHARS,
} from "@/lib/episodic/previously-format";
import type { ModelConfig } from "@/lib/models/registry";

vi.mock("@/lib/agents/sub-agent-runner", () => ({ runSubAgent: vi.fn() }));

const runSubAgentMock = vi.mocked(runSubAgent);

const MODEL = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
} satisfies ModelConfig;

const SLICE = "2026-08-17-0515";

type RunnerOpts = Parameters<typeof runSubAgent>[0];

async function callTool(opts: RunnerOpts, name: string, args: unknown): Promise<string> {
  const t = opts.tools[name] as unknown as {
    execute: (a: unknown, o: unknown) => Promise<string>;
  };
  return t.execute(args, { toolCallId: "test", messages: [] });
}

function baseInput(overrides: Partial<PreviouslyAgentInput> = {}): PreviouslyAgentInput {
  return {
    signal: "new_observation",
    note: "Auto-review of latest conversation.",
    model: MODEL,
    currentSliceId: SLICE,
    previouslyContent: newCardTemplate(SLICE),
    recentTurns: [{ role: "user", content: "我周五有个面试" }],
    todayLocal: "2026-08-17",
    readSliceFn: async () => "(none)",
    readAgentTimelineFn: async () => "(none)",
    readPreviouslyFn: async () => "(none)",
    ...overrides,
  };
}

beforeEach(() => {
  runSubAgentMock.mockReset();
});

describe("runner wiring", () => {
  it("runs on the shared runner: static system, dynamic user prompt, finish as the report tool", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing new", summary: "" },
      text: "",
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBeFalsy();
    expect(out.reasoning).toBe("nothing new");

    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.model).toBe(MODEL);
    expect(opts.maxSteps).toBe(30);
    expect(opts.timeoutMs).toBe(90_000);
    expect(opts.effort).toBe("low");
    expect(opts.temperature).toBe(0.1);
    expect(opts.reportToolName).toBe("finish");
    // Static system carries the role instructions; dynamic content is in the
    // user prompt only.
    expect(opts.system).toContain("Previously Agent");
    expect(opts.system).not.toContain("## Time context");
    expect(opts.prompt).toContain("## Time context");
    expect(opts.prompt).toContain("## Current card");
    expect(opts.prompt).toContain("我周五有个面试");
  });

  it("forwards the onLine live-line callback straight to the runner", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing new", summary: "" },
      text: "",
    });
    const onLine = vi.fn();
    await runPreviouslyAgent(baseInput({ onLine }));
    expect(runSubAgentMock.mock.calls[0][0].onLine).toBe(onLine);
  });

  it("a clean finish returns the serialized card", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "addNow", { text: "prepping the friday interview", refs: [SLICE] });
      return { ok: true, report: { reasoning: "added a hook", summary: "记下了面试" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.partial).toBeFalsy();
    expect(out.summary).toBe("记下了面试");
    expect(parseCard(out.updatedCard)?.now[0]?.text).toBe("prepping the friday interview");
    expect(out.mutations.some((m) => m.startsWith("addNow:"))).toBe(true);
  });
});

describe("partial output — step limit without finish", () => {
  it("returns a PARTIAL card with the mutations that landed, not failed + empty", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "addNow", { text: "prepping the friday interview", refs: [SLICE] });
      // …then burns the remaining steps and never calls finish.
      return { ok: true, report: undefined, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBe(true);
    expect(out.reasoning).toContain("step limit reached without finish");
    expect(parseCard(out.updatedCard)?.now[0]?.text).toBe("prepping the friday interview");
    // A partial pass is a result, not a failure — no retry.
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
  });

  it("the original bug: looping on the same over-long profile force-lands within 3 tries and still returns a partial card", async () => {
    const long = "p".repeat(CARD_PROFILE_MAX_CHARS + 200);
    const toolResults: string[] = [];
    runSubAgentMock.mockImplementation(async (opts) => {
      // The model resubmits the SAME over-limit profile until the step cap.
      for (let i = 0; i < 6; i++)
        toolResults.push(await callTool(opts, "updatePastProfile", { text: long }));
      return { ok: true, report: undefined, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(toolResults[0]).toContain("REJECTED");
    expect(toolResults[1]).toContain("LOOP BRAKE");
    expect(toolResults[2]).toMatch(/^OK — FORCED/); // 3rd: truncated + applied
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBe(true);
    expect(parseCard(out.updatedCard)?.past.profile).toHaveLength(CARD_PROFILE_MAX_CHARS);
    expect(out.mutations.some((m) => m.startsWith("forced:"))).toBe(true);
  });
});

describe("retry on hard failure", () => {
  it("retries once at temperature 0.4 when the first attempt fails", async () => {
    runSubAgentMock
      .mockResolvedValueOnce({ ok: false, error: "model unreachable", text: "" })
      .mockResolvedValueOnce({
        ok: true,
        report: { reasoning: "recovered", summary: "" },
        text: "",
      });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.reasoning).toBe("recovered");
    expect(runSubAgentMock).toHaveBeenCalledTimes(2);
    expect(runSubAgentMock.mock.calls[0][0].temperature).toBe(0.1);
    expect(runSubAgentMock.mock.calls[1][0].temperature).toBe(0.4);
  });

  it("fails with an empty card when both attempts fail", async () => {
    runSubAgentMock.mockResolvedValue({ ok: false, error: "boom", text: "" });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBe(true);
    expect(out.updatedCard).toBe("");
    expect(runSubAgentMock).toHaveBeenCalledTimes(2);
  });
});
