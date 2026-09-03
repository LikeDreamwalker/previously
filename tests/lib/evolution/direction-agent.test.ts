/**
 * Direction (src/lib/evolution/direction-agent.ts) — the evolution loop's
 * USER PORTRAIT + HYPOTHESIS POOL (v1.0 redesign, portrait-grade v0.9.2).
 * The contract that matters:
 *   - the doc has a fixed two-section skeleton (# Portrait with six fixed
 *     ## dimensions / # Hypotheses), descriptive-never-imperative by
 *     discipline;
 *   - a proposal is validated structurally: the skeleton (both sections AND
 *     all six dimensions), SUBSTANCE (Portrait and Hypotheses cannot both be
 *     empty/placeholder — heading lines alone are skeleton, not content), the
 *     bounded hypothesis pool (≤10, each line "- [proposed YYYY-MM-DD-HHMM]
 *     <guess> — falsify if: <condition>" with no other slice ids), the
 *     slice-id PLACEMENT (Portrait evidence only in trailing "— refs:" tails),
 *     the evidence bar (≥2 distinct slice pointers steady-state, ≥1 on
 *     bootstrap AND migrate), the size cap;
 *   - the mode is detected from the current doc: template → bootstrap,
 *     an old skeleton (# Direction / # Anti-goals, or the first portrait
 *     skeleton's # Evidence / # Log) → migrate, else steady;
 *   - buildDirectionBlock renders the L1b system-prompt layer (portrait +
 *     hypotheses-as-unverified-guesses) and is EMPTY for template/legacy docs;
 *   - retireExpiredHypotheses is the engineering half of the pool lifecycle:
 *     a guess still unverified TTL slices after its proposed pointer is
 *     stripped from the applied doc (Portrait lines never eligible);
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
  retireExpiredHypotheses,
  applyDirectionOps,
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

const DIMENSIONS = [
  "## Traits & cognitive style",
  "## Triggers & rhythms",
  "## Patterns & loops",
  "## Strengths & resilience",
  "## Communication preferences",
  "## Values & boundaries",
];

const VALID_PROPOSAL = [
  "# Portrait",
  "",
  DIMENSIONS[0],
  "",
  "- The user prefers concrete, evidence-anchored answers over generic advice. — refs: 2026-08-20-1430, 2026-08-22-1015",
  "",
  DIMENSIONS[1],
  "",
  DIMENSIONS[2],
  "",
  DIMENSIONS[3],
  "",
  DIMENSIONS[4],
  "",
  DIMENSIONS[5],
  "",
  "# Hypotheses",
  "",
  "- [proposed 2026-08-20-1430] The user may dislike long preambles — falsify if: they ask for more context",
].join("\n");

/** A valid hypothesis line with the structured metadata. */
function hypLine(
  proposed: string,
  guess: string,
  falsify = "the user asks for the opposite",
): string {
  return `- [proposed ${proposed}] ${guess} — falsify if: ${falsify}`;
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
    const noHyp = VALID_PROPOSAL.replace(/# Hypotheses[\s\S]*$/, "");
    const res = validateDirectionProposal(noHyp, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("# Hypotheses");
  });

  it("rejects a proposal missing a fixed Portrait dimension", () => {
    const noDim = VALID_PROPOSAL.replace("## Patterns & loops\n\n", "");
    const res = validateDirectionProposal(noDim, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("## Patterns & loops");
  });

  it("rejects a Portrait line whose slice id sits outside a trailing refs tail", () => {
    const bad = VALID_PROPOSAL.replace(
      "- The user prefers concrete, evidence-anchored answers over generic advice. — refs: 2026-08-20-1430, 2026-08-22-1015",
      "- In 2026-08-20-1430 the user corrected a vague answer, so they prefer concrete ones. — refs: 2026-08-22-1015",
    );
    const res = validateDirectionProposal(bad, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("refs");
  });

  it("rejects a hypothesis whose body cites slice ids (the only pointer is the proposed marker)", () => {
    const bad = VALID_PROPOSAL.replace(
      /^- \[proposed.*$/m,
      "- [proposed 2026-08-20-1430] The user may dislike preambles (see 2026-08-22-1015) — falsify if: they ask for more",
    );
    const res = validateDirectionProposal(bad, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("slice ids");
  });

  it("rejects a proposal with no slice pointer beyond a single one (steady bar)", () => {
    // Only the hypothesis's proposed marker survives → one distinct pointer.
    const noRefs = VALID_PROPOSAL.replace(
      " — refs: 2026-08-20-1430, 2026-08-22-1015",
      "",
    );
    const res = validateDirectionProposal(noRefs, null, { mode: "steady" });
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
      hypLine("2026-08-20-1430", `Guess number ${i + 1}`),
    ).join("\n");
    const doc = VALID_PROPOSAL.replace(
      /# Hypotheses\n\n[\s\S]*$/,
      `# Hypotheses\n\n${lines}`,
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
    // The SAME pointer twice still counts once.
    const onePointer = VALID_PROPOSAL.replace(
      " — refs: 2026-08-20-1430, 2026-08-22-1015",
      " — refs: 2026-08-20-1430, 2026-08-20-1430",
    );
    const res = validateDirectionProposal(onePointer, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("≥2");
  });

  it("bootstrap (the first-ever direction) clears with a single slice pointer", () => {
    const onePointer = VALID_PROPOSAL.replace(
      " — refs: 2026-08-20-1430, 2026-08-22-1015",
      " — refs: 2026-08-20-1430",
    );
    expect(
      validateDirectionProposal(onePointer, null, { mode: "bootstrap" }),
    ).toEqual({ ok: true });
    expect(validateDirectionProposal(onePointer, null).ok).toBe(false);
  });

  it("migrate (re-shaping an old skeleton) also clears with a single slice pointer", () => {
    const onePointer = VALID_PROPOSAL.replace(
      " — refs: 2026-08-20-1430, 2026-08-22-1015",
      " — refs: 2026-08-20-1430",
    );
    expect(
      validateDirectionProposal(onePointer, null, { mode: "migrate" }),
    ).toEqual({ ok: true });
  });

  it("rejects a doc with NO substantive content (Portrait + Hypotheses both empty/placeholder) — in every mode", () => {
    // Heading lines alone are skeleton, not content: such a doc would flip
    // detectDirectionMode to steady (the migrate gate goes dark forever)
    // while buildDirectionBlock renders nothing.
    const shell = [
      "# Portrait",
      "",
      "_(Not set yet — placeholder.)_",
      "",
      ...DIMENSIONS.flatMap((d) => [d, ""]),
      "# Hypotheses",
      "",
      "_(Not set yet — the pool is seeded on later runs.)_",
    ].join("\n");
    for (const mode of ["steady", "bootstrap", "migrate"] as const) {
      const res = validateDirectionProposal(shell, null, { mode });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("no substantive content");
    }
  });

  it("accepts when ONE section carries substance (hypotheses-only pool, or a portrait with a still-placeholder pool)", () => {
    const hypOnly = VALID_PROPOSAL.replace(
      "- The user prefers concrete, evidence-anchored answers over generic advice. — refs: 2026-08-20-1430, 2026-08-22-1015",
      "",
    ).replace(
      /^- \[proposed.*$/m,
      `${hypLine("2026-08-20-1430", "The user may dislike long preambles")}\n${hypLine("2026-08-22-1015", "The user may think out loud")}`,
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
        "# Portrait\n\n_(Not set yet — placeholder.)_\n\n## Traits & cognitive style\n\n# Hypotheses",
      ),
    ).toBe("bootstrap");
  });

  it("treats the old # Direction / # Anti-goals skeleton as migrate", () => {
    expect(
      detectDirectionMode(
        "# Direction\n\nPrefer concrete answers.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-08-20-1430 — x\n\n# Log\n\n- entry",
      ),
    ).toBe("migrate");
  });

  it("treats the FIRST portrait skeleton (# Evidence / # Log sections) as migrate", () => {
    expect(
      detectDirectionMode(
        "# Portrait\n\n- The user prefers concrete answers.\n\n# Hypotheses\n\n- [proposed 2026-08-20-1430 · checked 2026-08-22-1015] x — falsify if: y\n\n# Evidence\n\n- 2026-08-20-1430 — x\n\n# Log\n\n- entry",
      ),
    ).toBe("migrate");
  });

  it("treats a written new-skeleton doc as steady", () => {
    expect(detectDirectionMode(VALID_PROPOSAL)).toBe("steady");
  });
});

describe("retireExpiredHypotheses (the engineering TTL)", () => {
  const DOC = [
    "# Portrait",
    "",
    DIMENSIONS[0],
    "",
    "- The user prefers concrete, evidence-anchored answers. — refs: 2026-08-01-0900, 2026-08-02-0900",
    "",
    DIMENSIONS[1],
    DIMENSIONS[2],
    DIMENSIONS[3],
    DIMENSIONS[4],
    DIMENSIONS[5],
    "",
    "# Hypotheses",
    "",
    "- [proposed 2026-08-01-0900] The user may think better late at night — falsify if: late-slice energy stays flat",
    "- [proposed 2026-08-04-0900] The user may prefer plans over open exploration — falsify if: they reject structure twice",
    "- [proposed 2026-08-05-0900] The user may be terse under time pressure — falsify if: deadlines bring longer messages",
  ].join("\n");
  const CATALOG = [
    "2026-08-01-0900",
    "2026-08-02-0900",
    "2026-08-03-0900",
    "2026-08-04-0900",
    "2026-08-05-0900",
  ];

  it("retires a guess once TTL slices have passed since its proposed pointer", () => {
    const { doc, retired } = retireExpiredHypotheses(DOC, CATALOG);
    // 4 newer slices (08-02…08-05) → retired at exactly the TTL boundary.
    expect(retired).toHaveLength(1);
    expect(retired[0]).toContain("2026-08-01-0900");
    expect(doc).not.toContain("think better late at night");
    // 3 and 0 newer slices → kept.
    expect(doc).toContain("prefer plans over open exploration");
    expect(doc).toContain("terse under time pressure");
  });

  it("ages lexicographically — the proposed id need not appear in the catalog", () => {
    const { retired } = retireExpiredHypotheses(DOC, [
      "2026-08-01-1000",
      "2026-08-02-1000",
      "2026-08-03-1000",
      "2026-08-04-1000",
    ]);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toContain("2026-08-01-0900");
  });

  it("never touches Portrait lines, even ones whose refs cite old slices", () => {
    const { doc, retired } = retireExpiredHypotheses(DOC, CATALOG);
    expect(retired.every((l) => l.startsWith("- [proposed"))).toBe(true);
    expect(doc).toContain("evidence-anchored answers. — refs: 2026-08-01-0900");
  });

  it("leaves malformed pool lines for the validator", () => {
    const doc = `${DOC}\n- a guess without its proposed marker`;
    const { doc: out, retired } = retireExpiredHypotheses(doc, CATALOG);
    expect(out).toContain("a guess without its proposed marker");
    expect(retired).toHaveLength(1);
  });
});

describe("applyDirectionOps (the atomic write path)", () => {
  const SLICE = "2026-08-27-1000";
  const BASE = [
    "# Portrait",
    "",
    DIMENSIONS[0],
    "",
    "- The user prefers concrete answers. — refs: 2026-08-20-1430",
    "",
    DIMENSIONS[1],
    DIMENSIONS[2],
    DIMENSIONS[3],
    DIMENSIONS[4],
    DIMENSIONS[5],
    "",
    "# Hypotheses",
    "",
    "- [proposed 2026-08-25-0900] The user may think better late at night — falsify if: late energy stays flat",
  ].join("\n");

  it("adds a Portrait entry under the right dimension, preserving untouched lines", () => {
    const { doc, results, changed } = applyDirectionOps(
      BASE,
      [
        {
          op: "add_portrait",
          dimension: DIMENSIONS[4],
          text: "The user asks for sources when a claim matters",
          refs: ["2026-08-26-2100"],
        },
      ],
      { sliceId: SLICE },
    );
    expect(changed).toBe(true);
    expect(results[0].ok).toBe(true);
    expect(doc).toContain("The user prefers concrete answers. — refs: 2026-08-20-1430");
    const dimIdx = doc.indexOf(DIMENSIONS[4]);
    const entryIdx = doc.indexOf("asks for sources");
    expect(entryIdx).toBeGreaterThan(dimIdx);
    expect(entryIdx).toBeLessThan(doc.indexOf(DIMENSIONS[5]));
  });

  it("rejects an imperative-free violation the code CAN check: slice ids in text, missing refs, unknown dimension", () => {
    const { doc, results, changed } = applyDirectionOps(
      BASE,
      [
        { op: "add_portrait", dimension: DIMENSIONS[0], text: "Hiked on 2026-08-20-1430", refs: ["2026-08-20-1430"] },
        { op: "add_portrait", dimension: DIMENSIONS[0], text: "No refs here", refs: [] },
        { op: "add_portrait", dimension: "## Vibes", text: "x", refs: ["2026-08-20-1430"] },
      ],
      { sliceId: SLICE },
    );
    expect(changed).toBe(false);
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(doc).toBe(BASE);
  });

  it("stamps the [proposed] pointer itself on add_hypothesis and enforces the pool cap", () => {
    const { doc, results } = applyDirectionOps(
      BASE,
      [{ op: "add_hypothesis", text: "The user may prefer plans over open exploration", falsify: "they reject structure twice" }],
      { sliceId: SLICE },
    );
    expect(results[0].ok).toBe(true);
    expect(doc).toContain(`- [proposed ${SLICE}] The user may prefer plans over open exploration — falsify if: they reject structure twice`);

    let pooled = BASE;
    for (let i = 0; i < 9; i++) {
      pooled = applyDirectionOps(
        pooled,
        [{ op: "add_hypothesis", text: `guess number ${i}`, falsify: "x" }],
        { sliceId: SLICE },
      ).doc;
    }
    const full = applyDirectionOps(
      pooled,
      [{ op: "add_hypothesis", text: "one too many", falsify: "x" }],
      { sliceId: SLICE },
    );
    expect(full.results[0].ok).toBe(false);
    expect(full.results[0].detail).toContain("pool is full");
  });

  it("promote_hypothesis removes the guess AND lands the portrait entry in the same call", () => {
    const { doc, results } = applyDirectionOps(
      BASE,
      [
        {
          op: "promote_hypothesis",
          match: "think better late at night",
          dimension: DIMENSIONS[1],
          text: "The user's energy rises late at night",
          refs: ["2026-08-25-0900", "2026-08-26-2330"],
        },
      ],
      { sliceId: SLICE },
    );
    expect(results[0].ok).toBe(true);
    expect(doc).not.toContain("[proposed 2026-08-25-0900]");
    const dimIdx = doc.indexOf(DIMENSIONS[1]);
    expect(doc.indexOf("energy rises late at night")).toBeGreaterThan(dimIdx);
  });

  it("match ops require exactly ONE hit — zero or two is a rejection, not a guess", () => {
    const two = `${BASE}\n- [proposed 2026-08-26-0900] The user may think better in the morning — falsify if: x`;
    const { results } = applyDirectionOps(
      two,
      [
        { op: "remove_hypothesis", match: "think better" }, // ambiguous
        { op: "remove_hypothesis", match: "nonexistent guess" }, // no hit
      ],
      { sliceId: SLICE },
    );
    expect(results.map((r) => r.ok)).toEqual([false, false]);
  });

  it("update_portrait / remove_portrait hit only the Portrait, never the pool", () => {
    const { doc, results } = applyDirectionOps(
      BASE,
      [
        {
          op: "update_portrait",
          match: "prefers concrete answers",
          text: "The user prefers concrete, evidence-anchored answers",
          refs: ["2026-08-20-1430", "2026-08-22-1015"],
        },
      ],
      { sliceId: SLICE },
    );
    expect(results[0].ok).toBe(true);
    expect(doc).toContain("- The user prefers concrete, evidence-anchored answers — refs: 2026-08-20-1430, 2026-08-22-1015");
    expect(doc).toContain("[proposed 2026-08-25-0900]");
  });

  it("bootstrap: builds the new skeleton from a null current doc", () => {
    const { doc, changed } = applyDirectionOps(
      null,
      [
        {
          op: "add_portrait",
          dimension: DIMENSIONS[0],
          text: "The user builds structure before acting under uncertainty",
          refs: ["2026-08-27-1000"],
        },
      ],
      { sliceId: SLICE },
    );
    expect(changed).toBe(true);
    for (const d of DIMENSIONS) expect(doc).toContain(d);
    expect(doc).toContain("# Hypotheses");
    // …and the result passes the whole-doc gate at the (lowered) bootstrap bar.
    expect(validateDirectionProposal(doc, null, { mode: "bootstrap" })).toEqual({ ok: true });
  });
});

describe("directionSubstance (the shared placeholder rule)", () => {
  it("treats absent, empty, heading-only, and `_(`-placeholder sections as no content — the exact rule buildDirectionBlock uses", () => {
    expect(directionSubstance(null)).toBe("");
    expect(directionSubstance("   \n  ")).toBe("");
    expect(directionSubstance("_(Not set yet — placeholder.)_")).toBe("");
    expect(directionSubstance("\n  _(indented placeholder)_")).toBe("");
    expect(directionSubstance("## Traits & cognitive style\n\n## Triggers & rhythms")).toBe("");
    expect(directionSubstance("_(none yet)_\n\n## Patterns & loops")).toBe("");
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
        "# Portrait\n\n_(Not set yet — placeholder.)_\n\n## Traits & cognitive style\n\n## Triggers & rhythms\n\n## Patterns & loops\n\n## Strengths & resilience\n\n## Communication preferences\n\n## Values & boundaries\n\n# Hypotheses",
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

  it("renders the portrait as the user model, keeping the dimension structure", () => {
    const block = buildDirectionBlock(VALID_PROPOSAL);
    expect(block).toContain("## Direction — who the user is (evolved portrait)");
    expect(block).toContain("## Traits & cognitive style");
    expect(block).toContain(
      "The user prefers concrete, evidence-anchored answers over generic advice.",
    );
  });

  it("renders hypotheses explicitly as UNVERIFIED GUESSES (probe, never assert)", () => {
    const block = buildDirectionBlock(VALID_PROPOSAL);
    expect(block).toContain("UNVERIFIED GUESSES");
    expect(block).toContain("never assert one as fact");
    expect(block).toContain("The user may dislike long preambles");
  });

  it("omits the hypotheses subsection when the pool is empty", () => {
    const doc = VALID_PROPOSAL.replace(/# Hypotheses\n\n[\s\S]*$/, "# Hypotheses");
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

  it("accepts and returns a structurally valid ops proposal", async () => {
    ai.streamText.mockResolvedValue(
      makeToolCall({
        outcome: "propose",
        reason: "concreteness feedback recurred across slices",
        proposed: {
          ops: [
            {
              op: "add_portrait",
              dimension: "## Communication preferences",
              text: "The user prefers concrete, evidence-anchored answers",
              refs: ["2026-08-20-1430", "2026-08-22-1015"],
            },
            {
              op: "add_hypothesis",
              text: "The user may think better late at night",
              falsify: "late-slice energy stays flat",
            },
          ],
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
      expect(res.direction).toContain(
        "- The user prefers concrete, evidence-anchored answers — refs: 2026-08-20-1430, 2026-08-22-1015",
      );
      // Engineering stamped the proposed pointer with the run's slice.
      expect(res.direction).toContain(
        "- [proposed 2026-08-27-1000] The user may think better late at night — falsify if: late-slice energy stays flat",
      );
      expect(res.summary).toBe("First direction: concreteness");
      expect(res.evidence).toEqual(["2026-08-20-1430", "2026-08-22-1015"]);
      expect(res.expectedBenefit).toBe("Fewer vague answers");
    }
  });

  it("a structurally invalid op set degrades to no_change (rejections logged, nothing written)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ai.streamText.mockResolvedValue(
      makeToolCall({
        outcome: "propose",
        reason: "episodic fact as direction",
        proposed: {
          ops: [
            {
              op: "add_portrait",
              dimension: "## Traits & cognitive style",
              text: "Hiked on 2026-08-20-1430", // a slice id in the text — rejected
              refs: [],
            },
          ],
          summary: "bad",
          evidence: [],
          expectedBenefit: "none",
        },
      }),
    );
    const res = await runDirectionAgent(baseInput());
    expect(res.outcome).toBe("no_change");
    if (res.outcome === "no_change") {
      expect(res.reason).toContain("rejected");
    }
    expect(warn).toHaveBeenCalled();
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
    ai.streamText.mockResolvedValue(
      makeToolCall({
        outcome: "propose",
        reason: "seeding the baseline",
        proposed: {
          ops: [
            {
              op: "add_portrait",
              dimension: "## Communication preferences",
              text: "The user prefers concrete, evidence-anchored answers",
              refs: ["2026-08-20-1430"],
            },
          ],
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
