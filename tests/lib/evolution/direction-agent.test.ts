/**
 * Direction Agent (src/lib/evolution/direction-agent.ts) — Phase 1 of the
 * two-phase evolution loop (v1.0 design §2.3). The contract that matters:
 *   - "no change" is the common case and writes NOTHING (the module holds no
 *     write tools at all — the caller applies an accepted proposal);
 *   - a proposal is validated structurally (fixed four-section skeleton, the
 *     evidence bar — ≥2 distinct slice pointers steady-state, ≥1 on the
 *     bootstrap write — the size cap) — an invalid proposal degrades to
 *     no_change with the rejection logged;
 *   - runner failures degrade to { outcome: "failed" }, never throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

import {
  runDirectionAgent,
  validateDirectionProposal,
  DIRECTION_MAX_CHARS,
} from "@/lib/evolution/direction-agent";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";
import type { ModelConfig } from "@/lib/models/registry";

const model: ModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
};

const ANALYSIS: TurnAnalysis = {
  messageTags: { reuse: [], create: [] },
  semanticHint: { strands: [], reason: "" },
  memoryWorthy: true,
  emotionalSignal: { intensity: "none", register: "neutral", note: "" },
};

const VALID_PROPOSAL = `# Direction

Prefer concrete, evidence-anchored answers over generic advice.

# Anti-goals

Never drift into a life-coach persona.

# Evidence

- 2026-08-20-1430 — user corrected a vague answer
- 2026-08-22-1015 — user praised a concrete one

# Log

- 2026-08-27: first direction, from repeated concreteness feedback.`;

function makeToolCall(input: unknown) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolName: "directionReport", input }]),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    model,
    current: null,
    mode: "steady",
    cardSelfModel: null,
    recentEvents: [],
    analysis: ANALYSIS,
    sliceId: "2026-08-27-1000",
    ...overrides,
  } as Parameters<typeof runDirectionAgent>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateDirectionProposal", () => {
  it("accepts a well-formed proposal", () => {
    expect(validateDirectionProposal(VALID_PROPOSAL, null)).toEqual({ ok: true });
  });

  it("rejects a proposal missing a fixed section", () => {
    const noLog = VALID_PROPOSAL.replace(/# Log[\s\S]*$/, "");
    const res = validateDirectionProposal(noLog, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("# Log");
  });

  it("rejects a proposal with no slice pointer (cross-slice evidence bar)", () => {
    const noPointer = VALID_PROPOSAL.replaceAll(/2026-08-\d{2}-\d{4}/g, "a slice");
    const res = validateDirectionProposal(noPointer, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("slice pointer");
  });

  it("rejects an empty proposal and one identical to the current doc", () => {
    expect(validateDirectionProposal("  ", null).ok).toBe(false);
    expect(validateDirectionProposal(VALID_PROPOSAL, VALID_PROPOSAL).ok).toBe(false);
  });

  it("rejects an over-cap proposal", () => {
    const fat = VALID_PROPOSAL + "x".repeat(DIRECTION_MAX_CHARS);
    expect(validateDirectionProposal(fat, null).ok).toBe(false);
  });

  it("steady state needs ≥2 DISTINCT slice pointers (cross-slice bar)", () => {
    // One pointer only → rejected; the SAME pointer twice still counts once.
    const onePointer = VALID_PROPOSAL.replace(
      "- 2026-08-22-1015 — user praised a concrete one",
      "- 2026-08-20-1430 — same slice, restated",
    );
    const res = validateDirectionProposal(onePointer, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("≥2");
  });

  it("bootstrap (the first-ever direction) clears with a single slice pointer", () => {
    const onePointer = VALID_PROPOSAL.replace(
      "- 2026-08-22-1015 — user praised a concrete one",
      "- no second slice",
    );
    expect(
      validateDirectionProposal(onePointer, null, { bootstrap: true }),
    ).toEqual({ ok: true });
    expect(validateDirectionProposal(onePointer, null).ok).toBe(false);
  });
});

describe("runDirectionAgent", () => {
  it("the no-change path returns no_change and performs no writes (the module holds no write tools)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "one loud slice is not a direction" }),
    );
    const res = await runDirectionAgent(baseInput());
    expect(res).toEqual({
      outcome: "no_change",
      reason: "one loud slice is not a direction",
    });
    // The report tool is the ONLY tool — nothing to write with.
    const opts = ai.streamText.mock.calls.at(-1)?.[0] as { tools: Record<string, unknown> };
    expect(Object.keys(opts.tools)).toEqual(["directionReport"]);
  });

  it("accepts and returns a structurally valid proposal", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        outcome: "propose",
        reason: "concreteness feedback recurred across slices",
        proposed: {
          content: VALID_PROPOSAL,
          summary: "First direction: concreteness",
          evidence: ["2026-08-20-1430", "2026-08-22-1015"],
          expectedBenefit: "Fewer vague answers",
        },
      }),
    );
    const res = await runDirectionAgent(baseInput());
    expect(res.outcome).toBe("proposed");
    if (res.outcome === "proposed") {
      expect(res.direction).toContain("# Direction");
      expect(res.summary).toBe("First direction: concreteness");
      expect(res.evidence).toEqual(["2026-08-20-1430", "2026-08-22-1015"]);
      expect(res.expectedBenefit).toBe("Fewer vague answers");
    }
  });

  it("a structurally invalid proposal degrades to no_change (rejection logged, nothing written)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ai.streamText.mockResolvedValue(
      makeToolCall({
        outcome: "propose",
        reason: "episodic fact as direction",
        proposed: {
          content: "# Direction\n\nUser hiked yesterday.", // missing sections + pointer
          summary: "bad",
          evidence: [],
          expectedBenefit: "none",
        },
      }),
    );
    const res = await runDirectionAgent(baseInput());
    expect(res.outcome).toBe("no_change");
    if (res.outcome === "no_change") {
      expect(res.reason).toContain("proposal rejected");
    }
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("outcome=propose without a proposal body is treated as no_change", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "propose", reason: "forgot the document" }),
    );
    const res = await runDirectionAgent(baseInput());
    expect(res.outcome).toBe("no_change");
  });

  it("degrades to failed (never throws) when the model errors", async () => {
    ai.streamText.mockRejectedValue(new Error("boom"));
    const res = await runDirectionAgent(baseInput());
    expect(res.outcome).toBe("failed");
    if (res.outcome === "failed") expect(res.reason).toContain("boom");
  });

  it("sends a static system prompt; direction + events + analysis ride the user prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "nothing" }),
    );
    await runDirectionAgent(
      baseInput({
        current: "# Direction\n\nCurrent direction text.",
        recentEvents: [
          {
            ts: "2026-08-26T10:00:00Z",
            sliceId: "2026-08-26-1000",
            bucket: "recall",
            delta: -1,
            evidence: "not what we discussed",
          },
        ],
      }),
    );
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as {
      system: string;
      prompt: string;
    };
    expect(arg.system).toContain("Direction Agent");
    expect(arg.system).not.toContain("Current direction text");
    expect(arg.prompt).toContain("Current direction text");
    expect(arg.prompt).toContain("not what we discussed");
    expect(arg.prompt).toContain("2026-08-27-1000");
  });

  it("the mode and the Self-model promotion candidates ride the user prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "nothing" }),
    );
    await runDirectionAgent(
      baseInput({
        mode: "bootstrap",
        cardSelfModel: "- Don't decompose emotional venting with thinkDeep",
      }),
    );
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).toContain("BOOTSTRAP");
    expect(arg.prompt).toContain("Don't decompose emotional venting");
  });

  it("the recent closed-slice markings ride the user prompt (with an honest empty state)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "nothing" }),
    );
    await runDirectionAgent(
      baseInput({
        recentMarkings: [
          {
            id: "2026-08-27-0915",
            focus: "Shipped the release",
            summary: "Cut v1.0 and tagged it.",
            tone: "focused",
          },
        ],
      }),
    );
    let arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).toContain("Recent closed-slice markings");
    expect(arg.prompt).toContain("2026-08-27-0915 · Shipped the release");
    expect(arg.prompt).toContain("tone focused");

    await runDirectionAgent(baseInput({ recentMarkings: [] }));
    arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).toContain("(no marked slices yet)");
  });

  it("runs uncapped in steps with a 240s wall-clock budget (the old 1-step/60s cap caused silent failures)", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "nothing" }),
    );
    await runDirectionAgent(baseInput());
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg.stopWhen).toBeUndefined();
    expect(arg.timeout).toBe(240_000);
  });

  it("bootstrap mode accepts a first direction anchored to a single slice", async () => {
    const onePointer = VALID_PROPOSAL.replace(
      "- 2026-08-22-1015 — user praised a concrete one",
      "- no second slice",
    );
    ai.streamText.mockResolvedValue(
      makeToolCall({
        outcome: "propose",
        reason: "seeding the baseline",
        proposed: {
          content: onePointer,
          summary: "First direction",
          evidence: ["2026-08-20-1430"],
          expectedBenefit: "A baseline to evolve from",
        },
      }),
    );
    const res = await runDirectionAgent(baseInput({ mode: "bootstrap" }));
    expect(res.outcome).toBe("proposed");
  });
});
