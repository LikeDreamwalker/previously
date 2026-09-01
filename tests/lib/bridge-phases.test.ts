/**
 * bridge-phases — the phase-level housekeeping bridge call.
 *
 * The contract that matters:
 *   - payload assembly: { task, context, phase: "housekeeping", protocol: 2 }
 *     with the closing-slice flag in the task and all dynamic data in context;
 *   - lenient extraction (bare / fenced / prose-wrapped JSON), strict zod
 *     validation;
 *   - NEVER throws — bridge errors / malformed output / schema mismatch all
 *     degrade to { ok: false };
 *   - applyCardMutations routes the wire ops through the card-session
 *     machinery: caps are enforced, rejections land in `skipped` (no throw).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adaptHousekeepingReport,
  applyBridgeCardEvolution,
  applyCardMutations,
  buildHousekeepingPayload,
  degradedAnalysis,
  extractReportJson,
  isPhaseOutsourceActive,
  runHousekeepingBridge,
  type HousekeepingPhaseReport,
} from "@/lib/bridge-phases";
import { runBridge } from "@/lib/bridge";
import {
  writeCurrentPreviously,
  writePreviously,
} from "@/lib/episodic";
import {
  newCardTemplate,
  serializeCard,
} from "@/lib/episodic/previously-format";

vi.mock("@/lib/bridge", () => ({
  getBridgeCommand: vi.fn(() => "test bridge-exec"),
  splitBridgeCommand: vi.fn((s: string) => s.split(" ")),
  getBridgeTimeoutMs: vi.fn(() => 10_000),
  runBridge: vi.fn(),
  BRIDGE_PROTOCOL_VERSION: 2,
}));

vi.mock("@/lib/episodic", () => ({
  writeCurrentPreviously: vi.fn(async () => {}),
  writePreviously: vi.fn(async () => {}),
}));

// The card-evolution archive path must not touch the real memory/evolution/
// files from tests — mock the store read + the append-only archive write.
const evolutionArchive = vi.hoisted(() => ({
  appendMutationWithEvaluation: vi.fn(async () => ({
    evaluatedPreviousTs: null as string | null,
    markedIneffective: false,
  })),
  readFitness: vi.fn(async () => ({ events: [], signals: [] })),
}));
vi.mock("@/lib/evolution/acceptance", () => ({
  appendMutationWithEvaluation: evolutionArchive.appendMutationWithEvaluation,
}));
vi.mock("@/lib/evolution/store", () => ({
  readFitness: evolutionArchive.readFitness,
}));

const runBridgeMock = vi.mocked(runBridge);
const writeCurrentMock = vi.mocked(writeCurrentPreviously);
const writeSliceMock = vi.mocked(writePreviously);

const SLICE = "2026-08-22-1015";

const VALID_REPORT: HousekeepingPhaseReport = {
  analysis: {
    tags: { reuse: ["work"], create: ["interview-prep"] },
    semantic_hint: ["work"],
    intent: "chat",
    memory_worthy: true,
    memory_update: null,
    emotional_signal: { intensity: "light", register: "excited", note: "new job lead" },
  },
  closed_marking: null,
  evolution: {
    worth: true,
    reason: "A durable interview commitment was stated.",
    mutations: [
      { op: "addNow", content: "prepping the friday interview" },
      {
        op: "addHorizon",
        content: "interview on friday",
        by: "2026-08-28",
        refs: [SLICE],
      },
    ],
  },
  backfill_marks: [],
  strand_merges: [],
  fitness: [],
  direction: null,
};

function baseInput() {
  return {
    userMessage: "我周五有个面试",
    recentTurns: [{ role: "user", content: "我周五有个面试" }],
    existingStrandNames: ["work", "health"],
    cardContent: "",
    sliceId: SLICE,
    todayLocal: "2026-08-22",
    locale: "zh",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── payload assembly ────────────────────────────────────────────────────

describe("buildHousekeepingPayload", () => {
  it("puts the closing flag + schema in task and dynamic data in context", () => {
    const { task, context } = buildHousekeepingPayload({
      ...baseInput(),
      closingSlice: {
        sliceId: SLICE,
        turns: [{ role: "user", content: "old turn" }],
        tags: ["work"],
      },
    });
    expect(task).toContain(`slice ${SLICE} IS closing`);
    expect(task).toContain('"evolution"');
    expect(context).toContain('"我周五有个面试"');
    expect(context).toContain("work, health");
    expect(context).toContain("Closing slice");
    expect(context).toContain("2026-08-22");
  });

  it("marks closed_marking null when no slice is closing", () => {
    const { task, context } = buildHousekeepingPayload(baseInput());
    expect(task).toContain("closed_marking MUST be null");
    expect(context).not.toContain("Closing slice");
    expect(context).toContain("(empty — new card)");
  });

  it("pins the read-only evidence contract in the static task", () => {
    const { task } = buildHousekeepingPayload(baseInput());
    expect(task).toContain("from the data in this payload ALONE");
    expect(task).toContain("readslice / agentlog / card");
    expect(task).toContain("gated off in the housekeeping phase");
  });

  it("lists dry slices for the folded-in backfill job when provided", () => {
    const { task, context } = buildHousekeepingPayload({
      ...baseInput(),
      closingSlice: {
        sliceId: SLICE,
        turns: [{ role: "user", content: "old turn" }],
        tags: [],
      },
      drySlices: [
        { sliceId: "2026-08-10-1401", conversation: "user: 旧对话\nassistant: 回复" },
      ],
    });
    expect(task).toContain("Dry slices needing marks");
    expect(task).toContain("backfill_marks");
    expect(context).toContain("Dry slices needing marks");
    expect(context).toContain("### 2026-08-10-1401");
    expect(context).toContain("旧对话");
  });

  it("omits the dry-slice section when none are provided", () => {
    const { context } = buildHousekeepingPayload(baseInput());
    expect(context).not.toContain("Dry slices needing marks");
  });

  it("lists strand merge candidates with slice counts when provided", () => {
    const { task, context } = buildHousekeepingPayload({
      ...baseInput(),
      closingSlice: {
        sliceId: SLICE,
        turns: [{ role: "user", content: "old turn" }],
        tags: [],
      },
      strandsForMerge: [
        { name: "心态", slices: 3 },
        { name: "心态调整", slices: 1 },
      ],
    });
    expect(task).toContain("Strand merge candidates");
    expect(task).toContain("strand_merges");
    expect(context).toContain("Strand merge candidates");
    expect(context).toContain("- 心态 (3 slices)");
    expect(context).toContain("- 心态调整 (1 slice)");
  });

  it("omits the strand-merge section when no candidates are provided", () => {
    const { context } = buildHousekeepingPayload(baseInput());
    expect(context).not.toContain("Strand merge candidates");
  });

  it("carries the direction doc + mechanical signals in context when provided", () => {
    const { task, context } = buildHousekeepingPayload({
      ...baseInput(),
      directionContent: "# Direction\n\nKeep answers concrete.",
      signals: [
        {
          ts: "2026-08-22T10:00:00Z",
          sliceId: SLICE,
          type: "recall_rework",
          detail: "main agent read slice 2026-08-20-1430 outside recall's references",
        },
      ],
    });
    expect(task).toContain("Fitness scoring");
    expect(task).toContain("Direction verdict");
    expect(task).toContain('"fitness"');
    expect(task).toContain('"direction"');
    expect(context).toContain("Current evolution direction");
    expect(context).toContain("Keep answers concrete.");
    expect(context).toContain("Mechanical signals this slice");
    expect(context).toContain("recall_rework");
  });

  it("omits the signals section when none are provided", () => {
    const { context } = buildHousekeepingPayload(baseInput());
    expect(context).not.toContain("Mechanical signals this slice");
  });

  it("names the direction mode in context (migrate re-shape, lowered bar)", () => {
    const { context } = buildHousekeepingPayload({
      ...baseInput(),
      directionContent: "# Direction\n\nKeep answers concrete.\n\n# Anti-goals\n\nNo fluff.",
      directionMode: "migrate",
    });
    expect(context).toContain("mode: MIGRATE");
    expect(context).toContain("# Portrait / # Hypotheses / # Evidence / # Log");
  });
});

// ─── lenient extraction ──────────────────────────────────────────────────

describe("extractReportJson", () => {
  const bare = JSON.stringify(VALID_REPORT);

  it("parses a bare JSON object", () => {
    expect(extractReportJson(bare)).toEqual(VALID_REPORT);
  });

  it("parses a fenced block", () => {
    expect(extractReportJson(`Here is the report:\n\`\`\`json\n${bare}\n\`\`\``)).toEqual(
      VALID_REPORT,
    );
  });

  it("parses prose-wrapped JSON (stray text before and after)", () => {
    expect(
      extractReportJson(`I analyzed the turn. ${bare} Hope that helps!`),
    ).toEqual(VALID_REPORT);
  });

  it("prefers the LAST balanced object", () => {
    const other = JSON.stringify({ unrelated: true });
    expect(extractReportJson(`${other} then ${bare}`)).toEqual(VALID_REPORT);
  });

  it("returns null when nothing parses", () => {
    expect(extractReportJson("no json here at all")).toBeNull();
    expect(extractReportJson("{ not json")).toBeNull();
  });

  it("handles braces and escaped quotes inside JSON strings", () => {
    const tricky = JSON.parse(JSON.stringify(VALID_REPORT));
    tricky.evolution.reason = 'he said "{ \\" \\" }" then } {';
    const raw = JSON.stringify(tricky);
    expect(extractReportJson(raw)).toEqual(tricky);
  });
});

// ─── runHousekeepingBridge: validation + never-throw degradation ─────────

describe("runHousekeepingBridge", () => {
  it("sends the housekeeping phase payload and returns the validated report", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(VALID_REPORT),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report).toEqual(VALID_REPORT);

    const payload = JSON.parse(runBridgeMock.mock.calls[0][1] as string);
    expect(payload.phase).toBe("housekeeping");
    expect(payload.protocol).toBe(2);
    expect(typeof payload.task).toBe("string");
    expect(typeof payload.context).toBe("string");
  });

  it("accepts a prose-wrapped report", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: `analysis done\n\n${JSON.stringify(VALID_REPORT)}`,
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
  });

  it("tolerates an omitted backfill_marks field (defaults to [])", async () => {
    const sparse = JSON.parse(JSON.stringify(VALID_REPORT));
    delete sparse.backfill_marks;
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(sparse),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report.backfill_marks).toEqual([]);
  });

  it("tolerates an omitted strand_merges field (defaults to [])", async () => {
    const sparse = JSON.parse(JSON.stringify(VALID_REPORT));
    delete sparse.strand_merges;
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(sparse),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report.strand_merges).toEqual([]);
  });

  it("tolerates omitted fitness / direction fields (v1.0 — old reports stay valid)", async () => {
    const sparse = JSON.parse(JSON.stringify(VALID_REPORT));
    delete sparse.fitness;
    delete sparse.direction;
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(sparse),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.fitness).toEqual([]);
    expect(res.report.direction).toBeNull();
  });

  it("parses fitness deltas and a direction proposal when present", async () => {
    const rich = JSON.parse(JSON.stringify(VALID_REPORT));
    rich.fitness = [
      { bucket: "recall", delta: -1, evidence: "main agent re-read slice 2026-08-20-1430 outside recall's references" },
      { bucket: "interaction", delta: 1, evidence: "exactly what I needed" },
    ];
    rich.direction = {
      proposed: "# Direction\n\nKeep answers concrete.\n\n# Anti-goals\n\nNo fluff.\n\n# Evidence\n\n- 2026-08-20-1430\n- 2026-08-22-1015\n\n# Log\n\n- 2026-08-22: first direction.",
      summary: "First direction: concreteness",
      evidence: ["2026-08-20-1430"],
      expected_benefit: "Less vague advice",
    };
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(rich),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.fitness).toHaveLength(2);
    expect(res.report.fitness[0]).toEqual({
      bucket: "recall",
      delta: -1,
      evidence: "main agent re-read slice 2026-08-20-1430 outside recall's references",
    });
    expect(res.report.direction).not.toBeNull();
    expect(res.report.direction).not.toBe("no_change");
    if (res.report.direction && res.report.direction !== "no_change") {
      expect(res.report.direction.proposed).toContain("# Direction");
      expect(res.report.direction.summary).toBe("First direction: concreteness");
    }
  });

  it("accepts direction: \"no_change\" verbatim", async () => {
    const rich = JSON.parse(JSON.stringify(VALID_REPORT));
    rich.direction = "no_change";
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(rich),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report.direction).toBe("no_change");
  });

  it("truncates an over-cap fitness array instead of rejecting the report", async () => {
    const fat = JSON.parse(JSON.stringify(VALID_REPORT));
    fat.fitness = Array.from({ length: 8 }, (_, i) => ({
      bucket: "interaction",
      delta: 1,
      evidence: `e${i}`,
    }));
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(fat),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report.fitness).toHaveLength(5);
  });

  it("truncates over-cap arrays instead of rejecting the whole report", async () => {
    const fat = JSON.parse(JSON.stringify(VALID_REPORT));
    fat.analysis.tags.reuse = ["a", "b", "c", "d", "e", "f", "g"];
    fat.analysis.semantic_hint = ["a", "b", "c", "d", "e", "f"];
    fat.backfill_marks = Array.from({ length: 5 }, (_, i) => ({
      slice_id: `2026-08-1${i}-1000`,
      focus: "f",
      summary: "s",
    }));
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(fat),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.analysis.tags.reuse).toHaveLength(5);
    expect(res.report.analysis.semantic_hint).toHaveLength(5);
    expect(res.report.backfill_marks).toHaveLength(3);
  });

  it("tolerates omitted optional mutation fields (refs / by / evidence / resolution)", async () => {
    const sparse = JSON.parse(JSON.stringify(VALID_REPORT));
    sparse.evolution.mutations = [
      { op: "addHorizon", content: "interview on friday" },
      { op: "resolveHorizon", match: "old loop" },
      { op: "addSelfModel", content: "ask before refactoring" },
    ];
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(sparse),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.evolution.mutations).toEqual([
      { op: "addHorizon", content: "interview on friday", by: null, refs: [] },
      { op: "resolveHorizon", match: "old loop", resolution: "" },
      { op: "addSelfModel", content: "ask before refactoring", evidence: [] },
    ]);
  });

  it("prefers the valid report over an earlier fenced EXAMPLE block", async () => {
    // The agent shows a fenced example (parses, but isn't the report) before
    // emitting the real bare-JSON report — extraction must be guided by
    // validation, not by "first fenced block that parses".
    const example = '```json\n{"op": "addNow", "content": "example"}\n```';
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: `One mutation looks like this:\n${example}\n\nMy report:\n${JSON.stringify(VALID_REPORT)}`,
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report).toEqual(VALID_REPORT);
  });

  it("degrades on a bridge error (never throws)", async () => {
    runBridgeMock.mockResolvedValue({
      status: "error",
      reason: "bridge-not-found",
      error: "Bridge command not found",
      elapsedMs: 1,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("bridge-not-found");
  });

  it("degrades when runBridge itself rejects", async () => {
    runBridgeMock.mockRejectedValue(new Error("spawn blew up"));
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("spawn blew up");
  });

  it("degrades when no JSON object can be extracted", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: "I could not produce a report, sorry.",
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no JSON report");
  });

  it("degrades on a schema mismatch (bad intent value)", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_REPORT));
    bad.analysis.intent = "wizardry";
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(bad),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("schema validation");
  });

  it("passes onEvent/onDelta through to runBridge (live activity forwarding)", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(VALID_REPORT),
      elapsedMs: 5,
    });
    const onEvent = vi.fn();
    const onDelta = vi.fn();
    const res = await runHousekeepingBridge(baseInput(), { onEvent, onDelta });
    expect(res.ok).toBe(true);
    // runBridge(argv, payload, timeoutMs, extraEnv, onEvent, onDelta)
    const call = runBridgeMock.mock.calls[0];
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBe(onEvent);
    expect(call[5]).toBe(onDelta);
  });

  it("omits the live-activity hooks when no opts are given", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(VALID_REPORT),
      elapsedMs: 5,
    });
    await runHousekeepingBridge(baseInput());
    const call = runBridgeMock.mock.calls[0];
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
    expect(call[5]).toBeUndefined();
  });
});

// ─── gate ────────────────────────────────────────────────────────────────

describe("isPhaseOutsourceActive", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("keys on the resolved model sdk + kill-switch, regardless of how the engine was activated", () => {
    // Engine activated via config.json only (no PREVIOUSLY_BRAIN env): a turn
    // whose model resolved to sdk "bridge" still gets phase outsourcing —
    // that is what makes engine switching hot (no restart).
    delete process.env.PREVIOUSLY_PHASE_OUTSOURCE;
    delete process.env.PREVIOUSLY_BRAIN;
    delete process.env.PREVIOUSLY_MODE;
    expect(isPhaseOutsourceActive("bridge")).toBe(true);

    process.env.PREVIOUSLY_PHASE_OUTSOURCE = "0";
    expect(isPhaseOutsourceActive("bridge")).toBe(false);
  });

  it("is off for a BYOK model even under a bridge env brain", () => {
    // The env brain is bridge but the user picked a byok/* model (sdk
    // "openai") — housekeeping must run on the standard API sub-agent path,
    // not spawn the CLI.
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    delete process.env.PREVIOUSLY_PHASE_OUTSOURCE;
    expect(isPhaseOutsourceActive("openai")).toBe(false);
    expect(isPhaseOutsourceActive("deepseek")).toBe(false);
  });
});

// ─── report → TurnAnalysis adaptation ────────────────────────────────────

describe("adaptHousekeepingReport / degradedAnalysis", () => {
  it("maps the wire shape onto TurnAnalysis (create tags → {tag}, null → undefined)", () => {
    const a = adaptHousekeepingReport(VALID_REPORT, false);
    expect(a.messageTags).toEqual({
      reuse: ["work"],
      create: [{ tag: "interview-prep", reason: "" }],
    });
    expect(a.memoryWorthy).toBe(true);
    expect(a.memoryUpdate).toBeUndefined();
    expect(a.evolveCard).toBeUndefined(); // not closing
    expect(a.closedMarking).toBeUndefined();
  });

  it("carries evolveCard and a validated closed_marking tone when closing", () => {
    const report: HousekeepingPhaseReport = {
      ...VALID_REPORT,
      closed_marking: {
        focus: "interview prep",
        summary: "talked through the friday interview",
        tags: ["work"],
        tone: "excitedly positive nonsense", // not a valid tone
      },
    };
    const a = adaptHousekeepingReport(report, true);
    expect(a.evolveCard).toEqual({
      worth: true,
      reason: "A durable interview commitment was stated.",
    });
    expect(a.closedMarking?.focus).toBe("interview prep");
    expect(a.closedMarking?.tone).toBeNull(); // invalid tone dropped
  });

  it("degradedAnalysis mirrors the analyzer's failure contract", () => {
    const a = degradedAnalysis();
    expect(a.memoryWorthy).toBe(true);
    expect(a.messageTags).toEqual({ reuse: [], create: [] });
    expect(a.evolveCard).toBeUndefined();
  });

  it("maps report fitness deltas onto TurnAnalysis.fitness (empty → undefined)", () => {
    const withFitness: HousekeepingPhaseReport = {
      ...VALID_REPORT,
      fitness: [
        { bucket: "recall", delta: -1, evidence: "re-read outside references" },
      ],
    };
    const a = adaptHousekeepingReport(withFitness, false);
    expect(a.fitness).toEqual([
      { bucket: "recall", delta: -1, evidence: "re-read outside references" },
    ]);
    // The no-signal state carries NO fitness field — housekeeping appends nothing.
    expect(adaptHousekeepingReport(VALID_REPORT, false).fitness).toBeUndefined();
  });
});

// ─── card-mutation application (card-session machinery) ──────────────────

describe("applyCardMutations", () => {
  it("applies valid mutations through the session (refs default to the slice)", () => {
    const res = applyCardMutations(newCardTemplate(SLICE), SLICE, "2026-08-22", [
      { op: "addNow", content: "prepping the friday interview" },
      {
        op: "addHorizon",
        content: "interview on friday",
        by: "2026-08-28",
        refs: [],
      },
      { op: "setIdentity", content: "Name: Alan" },
    ]);
    expect(res.changed).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(res.card).toContain("prepping the friday interview");
    expect(res.card).toContain("interview on friday");
    expect(res.card).toContain("Name: Alan");
    // The session normalized the dash-form slice id into a slash-form ref.
    expect(res.card).toContain("2026/08/22/1015");
  });

  it("silently skips rejected mutations (caps / no-match / malformed)", () => {
    const res = applyCardMutations(newCardTemplate(SLICE), SLICE, "2026-08-22", [
      { op: "updatePastProfile", content: "x".repeat(10_000) }, // over the cap
      { op: "removeNow", match: "nothing matches this" },
      { op: "addHorizon", content: "no due date", by: null, refs: [] },
      { op: "setIdentity", content: "no label colon here" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.op)).toEqual([
      "updatePastProfile",
      "removeNow",
      "addHorizon",
      "setIdentity",
    ]);
  });

  it("removal ops mutate the existing card", () => {
    const base = serializeCard({
      sliceId: SLICE,
      updated: "2026-08-22T10:00:00.000Z",
      identity: [],
      past: { profile: "", anchors: [] },
      now: [
        { text: "prepping the friday interview", refs: ["2026/08/22/1015"], since: "2026-08-22" },
      ],
      horizon: [],
      selfModel: [],
    });
    const res = applyCardMutations(base, SLICE, "2026-08-22", [
      { op: "promoteNowToPast", match: "friday interview" },
    ]);
    expect(res.changed).toBe(true);
    expect(res.card).not.toContain("since:");
    expect(res.card).toContain("prepping the friday interview");
  });

  it("the legacy Self-model wire ops are SKIPPED with a pointer to the direction Portrait", () => {
    // The zod schema still accepts add/removeSelfModel (legacy tolerance), but
    // the card no longer carries the section — the applier skips them and says
    // where the lesson actually belongs.
    const res = applyCardMutations(newCardTemplate(SLICE), SLICE, "2026-08-22", [
      { op: "addSelfModel", content: "ask before refactoring", evidence: [] },
      { op: "removeSelfModel", match: "stale lesson" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.skipped.map((s) => s.op)).toEqual(["addSelfModel", "removeSelfModel"]);
    expect(res.skipped[0].reason).toContain("no longer carries a Self-model section");
    expect(res.skipped[0].reason).toContain("direction Portrait");
  });
});

// ─── write-back ──────────────────────────────────────────────────────────

describe("applyBridgeCardEvolution", () => {
  it("writes the live card + per-slice snapshot when substance moved", async () => {
    const res = await applyBridgeCardEvolution({
      card: newCardTemplate(SLICE),
      sliceId: SLICE,
      today: "2026-08-22",
      reason: "A durable interview commitment was stated.",
      mutations: [{ op: "addNow", content: "prepping the friday interview" }],
    });
    expect(res.changed).toBe(true);
    expect(res.summary).toBe("A durable interview commitment was stated.");
    expect(writeCurrentMock).toHaveBeenCalledOnce();
    expect(writeSliceMock).toHaveBeenCalledWith(SLICE, expect.any(String), undefined);
    // v1.0 §2.7 — the bridge write-back enters the same mutation archive as
    // the sub-agent path, with the slice id + reason as its evidence trail.
    expect(evolutionArchive.appendMutationWithEvaluation).toHaveBeenCalledOnce();
    expect(evolutionArchive.appendMutationWithEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "card",
        evidence: [SLICE, "A durable interview commitment was stated."],
        expectedBenefit: "A durable interview commitment was stated.",
      }),
      expect.anything(),
      undefined,
    );
  });

  it("never eats the landed card write when the archive write fails", async () => {
    evolutionArchive.appendMutationWithEvaluation.mockRejectedValueOnce(
      new Error("disk blew up"),
    );
    const res = await applyBridgeCardEvolution({
      card: newCardTemplate(SLICE),
      sliceId: SLICE,
      today: "2026-08-22",
      reason: "A durable interview commitment was stated.",
      mutations: [{ op: "addNow", content: "prepping the friday interview" }],
    });
    expect(res.changed).toBe(true);
    expect(writeCurrentMock).toHaveBeenCalledOnce();
    expect(writeSliceMock).toHaveBeenCalledOnce();
  });

  it("writes nothing when every mutation was rejected", async () => {
    const res = await applyBridgeCardEvolution({
      card: newCardTemplate(SLICE),
      sliceId: SLICE,
      today: "2026-08-22",
      reason: "tried but rejected",
      mutations: [{ op: "updatePastProfile", content: "x".repeat(10_000) }],
    });
    expect(res.changed).toBe(false);
    expect(res.note).toContain("rejected by validation");
    expect(writeCurrentMock).not.toHaveBeenCalled();
    expect(writeSliceMock).not.toHaveBeenCalled();
    expect(evolutionArchive.appendMutationWithEvaluation).not.toHaveBeenCalled();
  });
});
