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
import { writeDirection, appendMutation } from "@/lib/evolution/store";
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
// The v1.0 mutation-archive boundary (playbook write / fossil archive) is
// mocked so the tests stay hermetic — the real modules would read/write
// memory/evolution/ on the local fs.
vi.mock("@/lib/evolution/store", () => ({
  appendMutation: vi.fn(async () => {}),
  writeDirection: vi.fn(async () => {}),
  writePlaybook: vi.fn(async () => {}),
}));

const runPreviouslyAgentMock = vi.mocked(runPreviouslyAgent);
const readMock = vi.mocked(readCurrentPreviously);
const writeCurrentMock = vi.mocked(writeCurrentPreviously);
const writeSliceMock = vi.mocked(writePreviously);
const writeDirectionMock = vi.mocked(writeDirection);
const appendMutationMock = vi.mocked(appendMutation);

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

  it("archives an accepted card mutation as a bare fossil record (no cross-generation evaluation, v0.9.2)", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: CHANGED,
      reasoning: "folded new identity fact",
      summary: "identity updated",
      mutations: ["addNow: prepping the friday interview"],
    });
    await runCardEvolution(baseInput());
    expect(appendMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: "card" }),
      undefined,
    );
    // The record shape carries no evaluation fields — the archive is a
    // fossil record, never a scoreboard.
    const record = appendMutationMock.mock.calls[0][0];
    expect(record).not.toHaveProperty("evaluation");
  });
});

describe("the merged direction half (v1.1)", () => {
  const VALID_DIRECTION = [
    "# Portrait",
    "",
    "The user prefers concrete, evidence-anchored answers.",
    "",
    "# Hypotheses",
    "",
    "# Evidence",
    "",
    "- 2026-08-20-1430 — user corrected a vague answer",
    "- 2026-08-22-1015 — user praised a concrete one",
    "",
    "# Log",
    "",
    "- 2026-08-27: first direction.",
  ].join("\n");

  function directionEvalInput() {
    return {
      current: null,
      mode: "steady" as const,
      cardSelfModel: null,
      recentEvents: [],
      analysis: {
        messageTags: { reuse: [], create: [] },
        semanticHint: { strands: [], reason: "" },
        memoryWorthy: false,
        emotionalSignal: { intensity: "none" as const, register: "neutral" as const, note: "" },
      },
    };
  }

  function agentResultWithProposal(content: string) {
    return {
      updatedCard: BASE,
      reasoning: "direction moved",
      summary: "",
      mutations: [],
      directionProposal: {
        content,
        summary: "First direction: concreteness",
        evidence: ["2026-08-20-1430", "2026-08-22-1015"],
        expectedBenefit: "Fewer vague answers",
      },
    };
  }

  it("a valid proposal is written through writeDirection + archived with target direction", async () => {
    runPreviouslyAgentMock.mockResolvedValue(agentResultWithProposal(VALID_DIRECTION));
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction).toEqual({
      outcome: "updated",
      summary: "First direction: concreteness",
    });
    expect(writeDirectionMock).toHaveBeenCalledWith(VALID_DIRECTION, undefined);
    expect(appendMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "direction",
        summary: "First direction: concreteness",
        expectedBenefit: "Fewer vague answers",
      }),
      undefined,
    );
  });

  it("a REJECTED proposal reports outcome rejected with the reason (never a fake no_change) and writes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runPreviouslyAgentMock.mockResolvedValue(
      agentResultWithProposal("# Portrait\n\nNo skeleton, no evidence."),
    );
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction?.outcome).toBe("rejected");
    expect(res.direction?.summary).toBeTruthy(); // the validation reason
    expect(writeDirectionMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no proposal on finish → direction outcome no_change", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "direction holds",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction).toEqual({ outcome: "no_change" });
    expect(writeDirectionMock).not.toHaveBeenCalled();
  });

  it("a write failure surfaces outcome failed — never masquerading as no_change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeDirectionMock.mockRejectedValueOnce(new Error("disk full"));
    runPreviouslyAgentMock.mockResolvedValue(agentResultWithProposal(VALID_DIRECTION));
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction).toEqual({ outcome: "failed", summary: "disk full" });
    warn.mockRestore();
  });

  it("no directionEval (explicit-request path) → no direction verdict on the result", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.direction).toBeUndefined();
    expect(writeDirectionMock).not.toHaveBeenCalled();
  });
});
