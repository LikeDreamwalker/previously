/**
 * runCardEvolution — the inline card-evolution step's write-back rules.
 * The contract that matters: a FAILED agent errors and writes nothing; a
 * PARTIAL pass (step limit without finish) is written back like any other
 * result with the note flagged; a no-change pass writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCardEvolution } from "@/app/api/evolution/run-card-evolution";
import { runPreviouslyAgent } from "@/lib/episodic/flash/previously-agent";
import {
  readCurrentPreviously,
  writeCurrentPreviously,
  writePreviously,
} from "@/lib/episodic";
import {
  newCardTemplate,
  serializeCard,
} from "@/lib/episodic/previously-format";
import type { ModelConfig } from "@/lib/models/registry";

vi.mock("@/lib/episodic/flash/previously-agent", () => ({
  runPreviouslyAgent: vi.fn(),
}));
vi.mock("@/lib/episodic", () => ({
  readCurrentPreviously: vi.fn(),
  writeCurrentPreviously: vi.fn(),
  writePreviously: vi.fn(),
}));
// The v1.0 mutation-archive boundary (fitness store / playbook write /
// acceptance archive) is mocked so the tests stay hermetic — the real modules
// would read/write memory/evolution/ on the local fs.
vi.mock("@/lib/evolution/store", () => ({
  readFitness: vi.fn(async () => ({ events: [], signals: [] })),
  writePlaybook: vi.fn(async () => {}),
}));
vi.mock("@/lib/evolution/acceptance", () => ({
  appendMutationWithEvaluation: vi.fn(async () => ({
    evaluatedPreviousTs: null,
    markedIneffective: false,
  })),
}));

const runPreviouslyAgentMock = vi.mocked(runPreviouslyAgent);
const readMock = vi.mocked(readCurrentPreviously);
const writeCurrentMock = vi.mocked(writeCurrentPreviously);
const writeSliceMock = vi.mocked(writePreviously);

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
const BASE = newCardTemplate(SLICE);
const CHANGED = serializeCard({
  sliceId: SLICE,
  updated: "2026-08-17T06:00:00.000Z",
  identity: [],
  past: { profile: "", anchors: [] },
  now: [{ text: "prepping the friday interview", refs: ["2026/08/17/0515"], since: "2026-08-17" }],
  horizon: [],
  selfModel: [],
});

function baseInput() {
  return {
    model: MODEL,
    sliceId: SLICE,
    recentTurns: [{ role: "user", content: "我周五有个面试" }],
    readers: {
      readSlice: async () => "(none)",
      readAgentTimeline: async () => "(none)",
      readPreviously: async () => "(none)",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockResolvedValue(BASE);
});

describe("write-back rules", () => {
  it("a PARTIAL pass is written back with the note flagged, not treated as an error", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: CHANGED,
      reasoning: "step limit reached without finish",
      summary: "记下了你周五的面试",
      mutations: ["addNow: prepping the friday interview"],
      partial: true,
    });
    const res = await runCardEvolution(baseInput());
    expect(res.ran).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.note).toMatch(/^\[partial\] /);
    expect(res.note).toContain("step limit reached without finish");
    expect(res.partial).toBe(true);
    expect(writeCurrentMock).toHaveBeenCalledWith(CHANGED, undefined);
    expect(writeSliceMock).toHaveBeenCalledWith(SLICE, CHANGED, undefined);
    expect(res.summary).toBe("记下了你周五的面试");
  });

  it("a FAILED agent errors and writes nothing", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: "",
      reasoning: "Previously Agent worker unavailable",
      summary: "",
      mutations: [],
      failed: true,
    });
    const res = await runCardEvolution(baseInput());
    expect(res.ran).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.error).toBe("Previously Agent worker unavailable");
    expect(writeCurrentMock).not.toHaveBeenCalled();
    expect(writeSliceMock).not.toHaveBeenCalled();
  });

  it("a no-change pass writes nothing (stamps are ignored)", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.changed).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.note).toBe("nothing new"); // no [partial] flag on a clean pass
    expect(res.partial).toBeUndefined();
    expect(writeCurrentMock).not.toHaveBeenCalled();
  });

  it("forwards onEvolutionLine to the Previously Agent's onLine (live thinking)", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const onEvolutionLine = vi.fn();
    await runCardEvolution({ ...baseInput(), onEvolutionLine });
    expect(runPreviouslyAgentMock.mock.calls[0][0].onLine).toBe(onEvolutionLine);
  });

  it("surfaces accepted playbook writes with their archive summaries (v1.0 §2.4)", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "recall keeps guessing",
      summary: "",
      mutations: [],
      playbookWrites: [
        {
          agent: "recall" as const,
          content: "On emotional topics, read the full slice first.",
          evidence: ["2026-08-17-0515"],
          expectedBenefit: "fewer unverified recall answers",
        },
      ],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.playbooks).toEqual([
      { agent: "recall", summary: "fewer unverified recall answers" },
    ]);
  });

  it("omits the playbooks field when no playbook mutation landed", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.playbooks).toBeUndefined();
  });
});
