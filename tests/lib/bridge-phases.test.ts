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

  it("requires client mode + bridge brain + bridge model + no kill-switch", () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    delete process.env.PREVIOUSLY_PHASE_OUTSOURCE;
    expect(isPhaseOutsourceActive("bridge")).toBe(true);

    process.env.PREVIOUSLY_PHASE_OUTSOURCE = "0";
    expect(isPhaseOutsourceActive("bridge")).toBe(false);

    delete process.env.PREVIOUSLY_PHASE_OUTSOURCE;
    delete process.env.PREVIOUSLY_BRAIN;
    expect(isPhaseOutsourceActive("bridge")).toBe(false);

    process.env.PREVIOUSLY_BRAIN = "bridge";
    process.env.PREVIOUSLY_MODE = "cloud";
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
  });
});
