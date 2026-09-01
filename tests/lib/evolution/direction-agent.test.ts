/**
 * Direction (src/lib/evolution/direction-agent.ts) — the evolution loop's
 * USER PORTRAIT + HYPOTHESIS POOL (v1.0 redesign). The contract that matters:
 *   - the doc has a fixed four-section skeleton (# Portrait / # Hypotheses /
 *     # Evidence / # Log), descriptive-never-imperative by discipline;
 *   - a proposal is validated structurally: the skeleton, SUBSTANCE (Portrait
 *     and Hypotheses cannot both be empty/placeholder — such a doc would flip
 *     the mode to steady while rendering as no L1b layer at all), the bounded
 *     hypothesis pool (≤10, each line carrying proposed/checked metadata and
 *     a falsify-if condition), the evidence bar (≥2 distinct slice pointers
 *     steady-state, ≥1 on bootstrap AND migrate), the size cap;
 *   - the mode is detected from the current doc: template → bootstrap,
 *     old # Direction / # Anti-goals skeleton → migrate, else steady;
 *   - buildDirectionBlock renders the L1b system-prompt layer (portrait +
 *     hypotheses-as-unverified-guesses) and is EMPTY for template/legacy docs;
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
  detectDirectionMode,
  buildDirectionBlock,
  directionSubstance,
  DIRECTION_MAX_CHARS,
  DIRECTION_HYPOTHESES_MAX,
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

const VALID_PROPOSAL = `# Portrait

The user prefers concrete, evidence-anchored answers over generic advice.

# Hypotheses

- [proposed 2026-08-20-1430 · checked 2026-08-22-1015] The user may dislike long preambles — falsify if: they ask for more context

# Evidence

- 2026-08-20-1430 — user corrected a vague answer
- 2026-08-22-1015 — user praised a concrete one

# Log

- 2026-08-27: first direction, from repeated concreteness feedback.`;

/** A valid hypothesis line with the structured metadata. */
function hypLine(
  proposed: string,
  checked: string,
  guess: string,
  falsify = "the user asks for the opposite",
): string {
  return `- [proposed ${proposed} · checked ${checked}] ${guess} — falsify if: ${falsify}`;
}

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

  it("rejects a proposal with no slice pointer outside the hypothesis metadata", () => {
    // Keep the hypothesis line (its metadata format is valid) but strip every
    // Evidence pointer — the Evidence section must anchor the portrait.
    const noPointer = VALID_PROPOSAL.replace(
      /# Evidence\n\n- 2026-08-20-1430 — user corrected a vague answer\n- 2026-08-22-1015 — user praised a concrete one/,
      "# Evidence\n\n- a slice — user corrected a vague answer",
    );
    const res = validateDirectionProposal(noPointer, null, { mode: "steady" });
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

  it("rejects a hypothesis pool beyond the bound", () => {
    const lines = Array.from({ length: DIRECTION_HYPOTHESES_MAX + 1 }, (_, i) =>
      hypLine("2026-08-20-1430", "2026-08-22-1015", `Guess number ${i + 1}`),
    ).join("\n");
    const doc = VALID_PROPOSAL.replace(
      /# Hypotheses\n\n[\s\S]*?\n\n# Evidence/,
      `# Hypotheses\n\n${lines}\n\n# Evidence`,
    );
    const res = validateDirectionProposal(doc, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("too many hypotheses");
  });

  it("rejects a hypothesis line without the structured metadata", () => {
    const doc = VALID_PROPOSAL.replace(
      /^- \[proposed.*$/m,
      "- The user might prefer short answers",
    );
    const res = validateDirectionProposal(doc, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("malformed hypothesis line");
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
      validateDirectionProposal(onePointer, null, { mode: "bootstrap" }),
    ).toEqual({ ok: true });
    expect(validateDirectionProposal(onePointer, null).ok).toBe(false);
  });

  it("migrate (re-shaping the old skeleton) also clears with a single slice pointer", () => {
    const onePointer = VALID_PROPOSAL.replace(
      "- 2026-08-22-1015 — user praised a concrete one",
      "- no second slice",
    );
    expect(
      validateDirectionProposal(onePointer, null, { mode: "migrate" }),
    ).toEqual({ ok: true });
  });

  it("rejects a doc with NO substantive content (Portrait + Hypotheses both empty/placeholder) — in every mode", () => {
    // Such a doc would flip detectDirectionMode to steady (the migrate gate
    // goes dark forever) while buildDirectionBlock renders nothing.
    const shell = [
      "# Portrait",
      "",
      "_(Not set yet — placeholder.)_",
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
      "- 2026-08-27: re-shaped.",
    ].join("\n");
    for (const mode of ["steady", "bootstrap", "migrate"] as const) {
      const res = validateDirectionProposal(shell, null, { mode });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("no substantive content");
    }
  });

  it("accepts when ONE section carries substance (hypotheses-only pool, or a portrait with a still-placeholder pool)", () => {
    const hypOnly = VALID_PROPOSAL.replace(
      "The user prefers concrete, evidence-anchored answers over generic advice.",
      "",
    );
    expect(validateDirectionProposal(hypOnly, null)).toEqual({ ok: true });

    const placeholderPool = VALID_PROPOSAL.replace(
      /^- \[proposed.*$/m,
      "_(Not set yet — the pool is seeded on later runs.)_",
    );
    expect(
      validateDirectionProposal(placeholderPool, null, { mode: "bootstrap" }),
    ).toEqual({ ok: true });
  });
});

describe("detectDirectionMode", () => {
  it("treats a missing doc and the untouched template as bootstrap", () => {
    expect(detectDirectionMode(null)).toBe("bootstrap");
    expect(
      detectDirectionMode(
        "# Portrait\n\n_(Not set yet — placeholder.)_\n\n# Hypotheses\n\n# Evidence\n\n# Log",
      ),
    ).toBe("bootstrap");
  });

  it("treats the old # Direction / # Anti-goals skeleton as migrate", () => {
    expect(
      detectDirectionMode(
        "# Direction\n\nPrefer concrete answers.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-08-20-1430 — x\n- 2026-08-22-1015 — y\n\n# Log\n\n- entry",
      ),
    ).toBe("migrate");
  });

  it("treats a written new-skeleton doc as steady", () => {
    expect(detectDirectionMode(VALID_PROPOSAL)).toBe("steady");
  });
});

describe("directionSubstance (the shared placeholder rule)", () => {
  it("treats absent, empty, and `_(`-placeholder sections as no content — the exact rule buildDirectionBlock uses", () => {
    expect(directionSubstance(null)).toBe("");
    expect(directionSubstance("   \n  ")).toBe("");
    expect(directionSubstance("_(Not set yet — placeholder.)_")).toBe("");
    expect(directionSubstance("\n  _(indented placeholder)_")).toBe("");
    expect(directionSubstance("The user prefers concrete answers.")).toBe(
      "The user prefers concrete answers.",
    );
  });
});

describe("buildDirectionBlock", () => {
  it("is empty for a missing doc and for the untouched template", () => {
    expect(buildDirectionBlock(null)).toBe("");
    expect(
      buildDirectionBlock(
        "# Portrait\n\n_(Not set yet — placeholder.)_\n\n# Hypotheses\n\n# Evidence\n\n# Log",
      ),
    ).toBe("");
  });

  it("is empty for a legacy-skeleton doc (no Portrait/Hypotheses content yet)", () => {
    expect(
      buildDirectionBlock(
        "# Direction\n\nPrefer concrete answers.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-08-20-1430 — x\n\n# Log\n\n- entry",
      ),
    ).toBe("");
  });

  it("renders the portrait as the user model", () => {
    const block = buildDirectionBlock(VALID_PROPOSAL);
    expect(block).toContain("## Direction — who the user is (evolved portrait)");
    expect(block).toContain(
      "The user prefers concrete, evidence-anchored answers over generic advice.",
    );
  });

  it("renders hypotheses explicitly as UNVERIFIED GUESSES (probe, never assert)", () => {
    const block = buildDirectionBlock(VALID_PROPOSAL);
    expect(block).toContain("UNVERIFIED GUESSES");
    expect(block).toContain("never asserted as fact");
    expect(block).toContain("The user may dislike long preambles");
  });

  it("omits the hypotheses subsection when the pool is empty", () => {
    const doc = VALID_PROPOSAL.replace(/# Hypotheses\n\n[\s\S]*?\n\n# Evidence/, "# Evidence");
    const block = buildDirectionBlock(doc);
    expect(block).toContain("The user prefers concrete");
    expect(block).not.toContain("UNVERIFIED GUESSES");
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
      expect(res.direction).toContain("# Portrait");
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
          content: "# Portrait\n\nUser hiked yesterday.", // missing sections + pointer
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
        current: "# Portrait\n\nCurrent portrait text.",
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
    expect(arg.system).not.toContain("Current portrait text");
    expect(arg.prompt).toContain("Current portrait text");
    expect(arg.prompt).toContain("not what we discussed");
    expect(arg.prompt).toContain("2026-08-27-1000");
  });

  it("the mode and the legacy Self-model migration source ride the user prompt", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "nothing" }),
    );
    await runDirectionAgent(
      baseInput({
        mode: "bootstrap",
        cardSelfModel: "- The user vents emotions; decomposing that with thinkDeep felt cold",
      }),
    );
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).toContain("BOOTSTRAP");
    expect(arg.prompt).toContain("The user vents emotions");
  });

  it("migrate mode is named on the prompt with the lowered bar", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({ outcome: "no_change", reason: "nothing" }),
    );
    await runDirectionAgent(baseInput({ mode: "migrate" }));
    const arg = ai.streamText.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(arg.prompt).toContain("MIGRATE");
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
