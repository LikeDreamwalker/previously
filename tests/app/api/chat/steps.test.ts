import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput, TurnOutcome } from "@/lib/chat/turn-types";

// ── Mock the step dependencies ──────────────────────────────────────────

const episodic = vi.hoisted(() => ({
  createBatch: vi.fn(() => ({ entries: new Map<string, string>() })),
  flushBatch: vi.fn(async (_batch: unknown, _msg: string) => {}),
  sliceIdToFilePath: vi.fn(
    (sliceId: string) => `memory/episodic/slices/${sliceId}/timeline/core.md`
  ),
  tryLoadTodaySlice: vi.fn(),
  createSlice: vi.fn((msg: string, tz: string, turnId?: string, continuesFrom?: string) =>
    makeSlice({
      turns: [{ timestamp: "t", role: "user", content: msg }],
      ...(continuesFrom ? { continuesFrom } : {}),
    })
  ),
  closeSlice: vi.fn(),
  loadSlice: vi.fn(async (): Promise<TimeSlice | null> => null),
  appendTurn: vi.fn((slice: TimeSlice, turn: unknown) => {
    slice.turns.push(turn as TimeSlice["turns"][number]);
  }),
  saveSliceSnapshot: vi.fn(async () => {}),
  ensureIndexEntries: vi.fn(async () => {}),
  readPreviously: vi.fn(async () => ""),
  writePreviously: vi.fn(async () => {}),
  readCurrentPreviously: vi.fn(async () => ""),
  writeCurrentPreviously: vi.fn(async () => {}),
  writeAgentTimeline: vi.fn(async () => ({ path: "", created: false })),
  ensurePreviously: vi.fn(async (sliceId: string) => `# Previously On\n\n_Active slice: ${sliceId} | Updated: ..._\n`),
  generateGlobalTimeline: vi.fn(async () => "mock timeline"),
  weaveTimeline: vi.fn(async () => ({
    added: 0,
    removed: 0,
    newly_dry: 0,
    needs_marking: 0,
    total: 0,
    skipped: true,
  })),
  buildTimelineBrief: vi.fn(() => ""),
  readTimelineIndex: vi.fn(async () => null),
  upsertTimelineEntry: vi.fn(async () => {}),
  deterministicSliceMark: vi.fn(() => ({ focus: "fallback focus", summary: "fallback summary" })),
  readStrands: vi.fn(async () => ({})),
  analyzeTurn: vi.fn(
    async (_input: {
      model: unknown;
      userMessage: string;
      existingStrandNames: string[];
      closingSlice?: unknown;
      signals?: unknown[];
      portrait?: string;
    }): Promise<{
      messageTags: { reuse: string[]; create: Array<{ tag: string; reason: string }> };
      semanticHint: { strands: string[]; reason: string };
      memoryWorthy: boolean;
      emotionalSignal: { intensity: string; register: string; note: string };
      evolveCard?: { worth: boolean; reason: string };
      memoryUpdate?: { content: string; section?: string };
      fitness?: Array<{ bucket: string; delta: -2 | -1 | 0 | 1; evidence: string }>;
    }> => ({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
    }),
  ),
  shouldRunCardEvolution: vi.fn(
    (a: { evolveCard?: { worth: boolean } }) => a.evolveCard?.worth ?? true,
  ),
}));

// The inline card evolution is mocked at its module boundary so boundary
// gating can be asserted directly.
const evolution = vi.hoisted(() => ({
  runCardEvolution: vi.fn(
    async (_input: {
      sliceId?: string;
      signal?: string;
      closedSliceId?: string;
      focus?: string;
      onProgress?: (step: "reading" | "reviewing" | "applied") => void;
      onEvolutionLine?: (line: string, stage: "thinking" | "writing") => void;
      // v1.1 merged-run pass-through fields (asserted by the boundary tests).
      direction?: string | null;
      directionEval?: {
        current: string | null;
        mode: "bootstrap" | "migrate" | "steady";
        cardSelfModel: string | null;
        recentEvents: unknown[];
        analysis: unknown;
      };
      triggeredBuckets?: string[];
      fitnessEvents?: unknown[];
      fitnessSignals?: unknown[];
    }): Promise<{
      ran: boolean;
      changed: boolean;
      droppedRecent: number;
      note: string;
      summary?: string;
      partial?: boolean;
      error?: string;
      playbooks?: Array<{ agent: string; summary: string }>;
      direction?: { outcome: string; summary?: string };
    }> => ({ ran: true, changed: false, droppedRecent: 0, note: "reviewed" }),
  ),
}));
vi.mock("@/app/api/evolution/run-card-evolution", () => evolution);

let sliceAged = false;
let idleGapHit = false;

vi.mock("@/lib/episodic", () => episodic);
vi.mock("@/lib/episodic/flash/backfill-marks", () => ({
  backfillDrySliceMarks: vi.fn(async () => 0),
}));

// The interaction-signal writer is mocked at its module boundary — the real
// one double-writes the fitness store + the slice's agent.md.
const interactionSignal = vi.hoisted(() => ({
  logInteractionSignal: vi.fn(async () => {}),
}));
vi.mock("@/lib/episodic/rework-signal", () => interactionSignal);vi.mock("@/lib/episodic/slicer", () => ({
  checkSliceAge: () => sliceAged,
  checkIdleGap: () => idleGapHit,
}));

// The v1.0 evolution loop (fitness store / triggers / direction validation /
// fossil archive) is mocked at its module boundaries so the step tests
// stay hermetic — the real modules would read/write memory/evolution/ on the
// local fs.
const evolutionLoop = vi.hoisted(() => ({
  computeEvolutionTriggers: vi.fn((): Array<{ bucket: string; reason: string }> => []),
  validateDirectionProposal: vi.fn(() => ({ ok: true as const })),
  store: {
    appendFitnessEvents: vi.fn(
      async (_events: unknown[], _batch?: unknown) => {},
    ),
    appendMutation: vi.fn(async (_record: unknown, _batch?: unknown) => {}),
    appendSignal: vi.fn(async (_signal: unknown, _batch?: unknown) => {}),
    bucketNetScore: vi.fn(
      (_store: unknown, _bucket: string) => -4,
    ),
    emptyFitnessStore: () => ({
      events: [],
      signals: [],
      directionRejections: [],
    }),
    ensureEvolutionFiles: vi.fn(async () => {}),
    /* Pure predicates — mirror the real implementations so the direction gate
       tracks whatever readDirection is mocked to return. */
    isDirectionTemplate: (content: string | null): boolean =>
      content === null || content.includes("(Not set yet"),
    readDirection: vi.fn(async (): Promise<string | null> => null),
    readFitness: vi.fn(
      async (): Promise<{
        events: Array<Record<string, unknown>>;
        signals: Array<Record<string, unknown>>;
        directionRejections: string[];
      }> => ({ events: [], signals: [], directionRejections: [] }),
    ),
    readRecentSignals: vi.fn(async () => []),
    recordDirectionRejection: vi.fn(async () => {}),
    resetFitnessGeneration: vi.fn(async (_batch?: unknown) => {}),
    writeDirection: vi.fn(async () => {}),
  },
  /* Pure mirrors of the direction-agent helpers (template → bootstrap; the old
     # Direction / # Anti-goals skeleton → migrate; else steady). */
  detectDirectionMode: (
    content: string | null,
  ): "bootstrap" | "migrate" | "steady" =>
    content === null || content.includes("(Not set yet")
      ? "bootstrap"
      : /^# (Direction|Anti-goals)\s*$/m.test(content)
        ? "migrate"
        : "steady",
  buildDirectionBlock: (direction: string | null): string => {
    if (
      direction === null ||
      direction.includes("(Not set yet") ||
      !direction.includes("# Portrait")
    ) {
      return "";
    }
    return `## Direction — who the user is (evolved portrait)\n\n${direction}`;
  },
  /* Pure mirror of the direction-agent section extractor. */
  extractDirectionSection: (doc: string, heading: string): string | null => {
    const lines = doc.split("\n");
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) return null;
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith("# ")) break;
      body.push(lines[i]);
    }
    return body.join("\n").trim();
  },
}));
vi.mock("@/lib/evolution/triggers", () => ({
  computeEvolutionTriggers: evolutionLoop.computeEvolutionTriggers,
}));
vi.mock("@/lib/evolution/direction-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/evolution/direction-agent")>();
  return {
    ...actual,
    buildDirectionBlock: evolutionLoop.buildDirectionBlock,
    detectDirectionMode: evolutionLoop.detectDirectionMode,
    validateDirectionProposal: evolutionLoop.validateDirectionProposal,
    // extractDirectionSection / retireExpiredHypotheses / applyDirectionOps /
    // directionOpSchema stay REAL — they are pure functions/schemas, and the
    // bridge-verdict path should exercise the actual ops logic.
  };
});
vi.mock("@/lib/evolution/store", () => evolutionLoop.store);

// Mock AI SDK for Flash tag extraction in housekeeping (and any sub-agent
// going through the unified runner, which streams via streamText).
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({ toolCalls: [] })),
    streamText: vi.fn(async () => ({
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      reasoningText: Promise.resolve(undefined),
      sources: Promise.resolve([]),
      warnings: Promise.resolve([]),
    })),
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(
    () => (id: string) => ({ modelId: id }),
  ),
}));

// The run's writable: collects everything written for assertions.
const workflowMock = vi.hoisted(() => {
  const written: Array<Record<string, unknown>> = [];
  return {
    written,
    getWritable: vi.fn(() => ({
      getWriter: () => ({
        write: async (chunk: unknown) => {
          written.push(chunk as Record<string, unknown>);
        },
        releaseLock: () => {},
      }),
      close: async () => {},
    })),
  };
});

vi.mock("workflow", () => ({ getWritable: workflowMock.getWritable }));

import { housekeeping, finalizeTurn } from "@/app/api/chat/steps";

function makeSlice(overrides: Partial<TimeSlice> = {}): TimeSlice {
  return {
    slice_id: "2026-07-14-0900",
    focus: "",
    status: "active",
    start: "2026-07-14T09:00:00.000Z",
    timezone: "UTC",
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    loops: [],
    turns: [],
    estimatedTokens: 0,
    emotional_tone: "neutral",
    ...overrides,
  };
}

function makeInput(lastUserMessage: string, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    modelMessages: [],
    recentTurns: [],
    lastUserMessage,
    model: "deepseek-v4-flash",
    modelConfig: {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
      sdk: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      capabilities: { thinking: true, vision: false, maxTokens: 393216 },
      defaultThinking: false,
      defaultEffort: "low",
    },
    thinking: true,
    reasoningEffort: "medium" as const,
    clientTimezone: "UTC",
    locale: "en",
    config: {
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 40, idleGapMinutes: 15 },
      model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "medium" as const },
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-07-14T10:00:00.000Z",
    turnId: "test-id",
    imageAttachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workflowMock.written.length = 0;
  sliceAged = false;
  idleGapHit = false;
});

describe("housekeeping step", () => {
  it("creates a fresh slice when none is on disk and returns it by value", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    const { slice } = await housekeeping(makeInput("hello world"));

    expect(episodic.createSlice).toHaveBeenCalledWith("hello world", "UTC", "test-id");
    expect(slice.turns).toHaveLength(1);
    expect(slice.turns[0].content).toBe("hello world");
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice, expect.anything());
    expect(episodic.ensureIndexEntries).toHaveBeenCalledWith(slice, expect.anything());
    // A slice created this turn lands in the timeline catalog in the same batch.
    expect(episodic.upsertTimelineEntry).toHaveBeenCalledWith(slice, expect.anything());
    expect(episodic.appendTurn).not.toHaveBeenCalled();

    // 10 compact housekeeping phases (slice/analyze/tags/context/strands ×
    // running+done) then the stream lifecycle chunks.
    expect(workflowMock.written.map((c) => c.type)).toEqual([
      ...Array(10).fill("data-phase"),
      "start",
      "start-step",
    ]);
    const phases = workflowMock.written
      .filter((c) => c.type === "data-phase")
      .map((c) => (c.data as { phase: string; running: boolean; compact?: boolean }));
    expect(phases.map((p) => `${p.phase}:${p.running}`)).toEqual([
      "slice:true",
      "analyze:true",
      "analyze:false",
      "tags:true",
      "tags:false",
      "slice:false",
      "context:true",
      "strands:true",
      "strands:false",
      "context:false",
    ]);
    expect(phases.every((p) => p.compact === true)).toBe(true);
  });

  it("restores an active slice and appends the new user turn", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);

    // Include assistant messages so context continuity check passes
    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice } = await housekeeping(input);

    expect(episodic.createSlice).not.toHaveBeenCalled();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe(disk.slice_id);
    expect(slice.turns).toHaveLength(3);
    expect(slice.turns[2].content).toBe("follow up");
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice, expect.anything());
    // Restored (not created) — no catalog upsert needed.
    expect(episodic.upsertTimelineEntry).not.toHaveBeenCalled();
  });

  it("closes an over-age slice on time_cap and starts a new one", async () => {
    sliceAged = true;
    const disk = makeSlice({ turns: [{ timestamp: "t0", role: "user", content: "old" }] });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1000", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    const { slice } = await housekeeping(makeInput("new topic"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "time_cap", expect.anything());
    expect(slice.slice_id).toBe("2026-07-14-1000");
  });

  it("force-closes on turn cap and starts a new one", async () => {
    const disk = makeSlice({
      turns: Array.from({ length: 40 }, (_, i) => ({ timestamp: `t${i}`, role: "user" as const, content: `m${i}` })),
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1100", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    const { slice } = await housekeeping(makeInput("keep going"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "capacity", expect.anything());
    expect(slice.slice_id).toBe("2026-07-14-1100");
  });

  it("closes on context_lost when client has no assistant messages but slice has agent turns", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
        { timestamp: "t2", role: "user", content: "another" },
        { timestamp: "t3", role: "agent", content: "reply2" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1200", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    // modelMessages has only the current user message, no assistant messages
    const input = makeInput("new from different device");
    const { slice } = await housekeeping(input);

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "context_lost", expect.anything());
    expect(slice.slice_id).toBe("2026-07-14-1200");
  });

  it("regenerate: no duplicate user turn, no context_lost, and an interaction signal", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "same question" },
        { timestamp: "t1", role: "agent", content: "rejected reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);

    // The SDK truncated the rejected assistant message locally, so the
    // history legitimately carries NO assistant message — normally the
    // context_lost heuristic would fire (0 assistant vs ≥1 agent turns).
    const { slice } = await housekeeping(
      makeInput("same question", { regenerate: true }),
    );

    // The slice survives and the question is NOT re-appended.
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe(disk.slice_id);
    expect(slice.turns).toHaveLength(2);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
    // …and the rejection is recorded as a mechanical fitness signal.
    expect(interactionSignal.logInteractionSignal).toHaveBeenCalledWith(
      "interaction_regenerate",
      disk.slice_id,
      expect.stringContaining("regenerated"),
      expect.anything(),
    );
  });

  it("no interaction signal on an ordinary turn", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    await housekeeping(makeInput("hello world"));
    expect(interactionSignal.logInteractionSignal).not.toHaveBeenCalled();
  });

  it("returns previouslyContent and strandsMenu along with slice", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);

    const result = await housekeeping(makeInput("hello world"));

    expect(result.previouslyContent).toBeDefined();
    expect(typeof result.previouslyContent).toBe("string");
    expect(result.strandsMenu).toBeDefined();
    expect(typeof result.strandsMenu).toBe("string");
  });
});

describe("slicing policy: idle_gap close + checkpoint continuation", () => {
  /** createSlice impl that honors the production 4th arg (continuesFrom). */
  function mockCreateSlice(newSliceId: string) {
    episodic.createSlice.mockImplementation(
      (msg: string, _tz: string, _turnId?: string, continuesFrom?: string) =>
        makeSlice({
          slice_id: newSliceId,
          turns: [{ timestamp: "t", role: "user", content: msg }],
          ...(continuesFrom ? { continuesFrom } : {}),
        }),
    );
  }

  it("closes on idle_gap when the last turn is older than the idle gap — a genuine new conversation", async () => {
    idleGapHit = true;
    const disk = makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old topic" }],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    mockCreateSlice("2026-07-14-1000");

    const { slice, contextPrefix } = await housekeeping(makeInput("back after lunch"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "idle_gap", expect.anything());
    // No continuation link, no carry-over — the user left and came back.
    expect(slice.continuesFrom).toBeUndefined();
    expect(contextPrefix).toBeUndefined();
    expect(episodic.loadSlice).not.toHaveBeenCalled();
  });

  it("idle gap wins over time_cap when both thresholds are exceeded", async () => {
    idleGapHit = true;
    sliceAged = true;
    const disk = makeSlice({
      turns: [{ timestamp: "t0", role: "user", content: "old topic" }],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    mockCreateSlice("2026-07-14-1000");

    await housekeeping(makeInput("much later"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "idle_gap", expect.anything());
  });

  it("does NOT idle-close when the gap is below the threshold", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);

    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice } = await housekeeping(input);

    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(slice.slice_id).toBe(disk.slice_id);
  });

  it("time_cap close links the new slice via continuesFrom and carries the closed slice's tail", async () => {
    sliceAged = true;
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    mockCreateSlice("2026-07-14-1000");

    const { slice, contextPrefix } = await housekeeping(makeInput("next question"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "time_cap", expect.anything());
    expect(slice.continuesFrom).toBe("2026-07-14-0900");
    // The just-closed slice is already in memory — no re-read needed.
    expect(episodic.loadSlice).not.toHaveBeenCalled();
    expect(contextPrefix).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("capacity close also links via continuesFrom", async () => {
    const disk = makeSlice({
      turns: Array.from({ length: 40 }, (_, i) => ({
        timestamp: `t${i}`,
        role: "user" as const,
        content: `m${i}`,
      })),
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    mockCreateSlice("2026-07-14-1100");

    const { slice, contextPrefix } = await housekeeping(makeInput("keep going"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "capacity", expect.anything());
    expect(slice.continuesFrom).toBe("2026-07-14-0900");
    // Only the last 10 turns are carried.
    expect(contextPrefix).toHaveLength(10);
    expect(contextPrefix?.[0]).toEqual({ role: "user", content: "m30" });
  });

  it("context_lost close gets NO continuation link and no carry-over", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
        { timestamp: "t2", role: "user", content: "another" },
        { timestamp: "t3", role: "agent", content: "reply2" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    mockCreateSlice("2026-07-14-1200");

    const { slice, contextPrefix } = await housekeeping(makeInput("new from different device"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "context_lost", expect.anything());
    expect(slice.continuesFrom).toBeUndefined();
    expect(contextPrefix).toBeUndefined();
  });

  it("later turns of a checkpointed slice re-read the frozen predecessor via loadSlice", async () => {
    const disk = makeSlice({
      slice_id: "2026-07-14-1000",
      continuesFrom: "2026-07-14-0900",
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
        { timestamp: "t2", role: "user", content: "q2" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.loadSlice.mockResolvedValue(
      makeSlice({
        slice_id: "2026-07-14-0900",
        status: "closed",
        turns: Array.from({ length: 12 }, (_, i) => ({
          timestamp: `p${i}`,
          role: i % 2 === 0 ? ("user" as const) : ("agent" as const),
          content: `p${i}`,
        })),
      }),
    );
    try {
      const input = makeInput("q2", {
        modelMessages: [
          { role: "assistant", content: "a1" },
        ] as unknown as TurnInput["modelMessages"],
      });
      const { contextPrefix } = await housekeeping(input);

      expect(episodic.loadSlice).toHaveBeenCalledWith("2026-07-14-0900", expect.anything());
      // The tail is capped at the last 10 turns, roles mapped to the wire shape.
      expect(contextPrefix).toHaveLength(10);
      expect(contextPrefix?.[0]).toEqual({ role: "user", content: "p2" });
      expect(contextPrefix?.[9]).toEqual({ role: "assistant", content: "p11" });
    } finally {
      episodic.loadSlice.mockResolvedValue(null);
    }
  });

  it("unreadable predecessor degrades to no carry-over (best-effort)", async () => {
    const disk = makeSlice({
      slice_id: "2026-07-14-1000",
      continuesFrom: "2026-07-14-0900",
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.loadSlice.mockResolvedValue(null);

    const input = makeInput("q1", {
      modelMessages: [
        { role: "assistant", content: "a1" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice, contextPrefix } = await housekeeping(input);

    // The turn proceeds normally — just without the carried tail.
    expect(slice.slice_id).toBe("2026-07-14-1000");
    expect(contextPrefix).toBeUndefined();
  });

  it("emits the checkpoint continuity tier for a continued slice", async () => {
    sliceAged = true;
    const disk = makeSlice({
      focus: "rust loops",
      turns: [
        { timestamp: "t0", role: "user", content: "q1" },
        { timestamp: "t1", role: "agent", content: "a1" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    mockCreateSlice("2026-07-14-1000");

    await housekeeping(makeInput("next question"));

    const chunk = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string; running: boolean }).phase === "context" &&
        (c.data as { running: boolean }).running === false,
    );
    const summaries =
      ((chunk?.data as { summaries?: string[] } | undefined)?.summaries ?? []) as string[];
    expect(summaries.join(" ")).toContain("continuity: checkpoint");
  });
});

describe("housekeeping boundary evolution gating", () => {
  function setupClosingSlice() {
    sliceAged = true;
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
        { timestamp: "t2", role: "user", content: "more" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1000", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );
    return disk;
  }

  function mockAnalysis(evolveCard?: { worth: boolean; reason: string }) {
    episodic.analyzeTurn.mockResolvedValue({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
      ...(evolveCard ? { evolveCard } : {}),
    });
  }

  it("runs the LLM evolution when the analyzer judges the boundary worth it", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "a durable preference was stated" });

    await housekeeping(makeInput("wrapping up"));

    expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
  });

  it("skips the LLM evolution when worth=false and emits a visible skip", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });

    await housekeeping(makeInput("wrapping up"));

    expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    // The skip is visible: a terminal evolution chunk carrying the reason.
    const evoChunks = workflowMock.written.filter((c) => c.type === "data-evolution");
    expect(evoChunks).toHaveLength(1);
    const data = evoChunks[0].data as { running: boolean; note: string };
    expect(data.running).toBe(false);
    expect(data.note).toContain("pure logistics");
  });

  it("defaults to running the evolution when the analyzer gave no judgment (failure fallback)", async () => {
    setupClosingSlice();
    mockAnalysis(undefined); // analyzer degraded — no evolveCard field

    await housekeeping(makeInput("wrapping up"));

    expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
  });

  it("FORCES the run when the card is still a legacy (pre-v5) format, worth=false notwithstanding", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    // v1 card: stamp "Format: user card" (no v2) — migration must not wait for
    // a worthy boundary.
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card | Updated: 2026-07-14T09:30:00.000Z_\n\n## Identity\n\n- Name: Alan\n\n## Profile\n\nA full-stack engineer.\n",
    );
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
    }
  });

  it("does NOT force the run when the card is already v5", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n\n## Identity\n\n- Name: Alan\n",
    );
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
    }
  });

  // ── v1.1 merged-run orchestration (direction evaluated INSIDE the one
  //    runCardEvolution call — the old two-phase split is gone) ────────────

  it("a triggered boundary runs the ONE merged evolution: directionEval (current doc + mode) + triggers ride the input", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "durable" });
    evolutionLoop.store.readDirection.mockResolvedValue(
      "# Portrait\n\nThe user prefers concrete answers.\n\n# Hypotheses\n\n# Evidence\n\n# Log",
    );
    evolutionLoop.store.resetFitnessGeneration.mockClear();
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "recall", reason: "net -5" },
    ]);
    evolution.runCardEvolution.mockImplementationOnce(async (input) => {
      expect(input.directionEval?.current).toContain("# Portrait");
      expect(input.directionEval?.mode).toBe("steady");
      expect(input.triggeredBuckets).toEqual(["recall"]);
      return {
        ran: true,
        changed: false,
        droppedRecent: 0,
        note: "reviewed",
        direction: { outcome: "no_change" },
      };
    });
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      // The direction write-back lives INSIDE runCardEvolution now — the step
      // never touches writeDirection / the archive itself on this path.
      expect(evolutionLoop.store.writeDirection).not.toHaveBeenCalled();
      expect(evolutionLoop.store.appendMutation).not.toHaveBeenCalled();
      // A successful FITNESS-TRIGGERED run settles the generation (v0.9.2).
      expect(evolutionLoop.store.resetFitnessGeneration).toHaveBeenCalledOnce();
    } finally {
      evolutionLoop.store.readDirection.mockResolvedValue(null);
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
      evolutionLoop.store.resetFitnessGeneration.mockClear();
    }
  });

  it("an analyzer-gated run WITHOUT fitness triggers does NOT settle the generation (it never saw the pressure)", async () => {
    setupClosingSlice();
    evolutionLoop.store.resetFitnessGeneration.mockClear();
    mockAnalysis({ worth: true, reason: "durable" }); // card gate ON, triggers empty
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: true,
      droppedRecent: 0,
      note: "evolved",
      summary: "folded a durable fact",
    });
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(evolutionLoop.store.resetFitnessGeneration).not.toHaveBeenCalled();
    } finally {
      evolutionLoop.store.resetFitnessGeneration.mockClear();
    }
  });

  it("a non-card bucket trigger runs the merged evolution even when worth=false and the card is v5", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "thinkdeep", reason: 'immediate -2: "stop overthinking"' },
    ]);
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(
        evolution.runCardEvolution.mock.calls[0][0].triggeredBuckets,
      ).toEqual(["thinkdeep"]);
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
    }
  });

  it("no trigger and no card gate → the merged evolution never runs", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
    }
  });

  it("the direction gate alone fires the merged run: a MIGRATE-mode doc (old skeleton) is always due", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    evolutionLoop.store.readDirection.mockResolvedValue(
      "# Direction\n\nBe concrete.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-07-14-0900 — x\n\n# Log\n\n- entry",
    );
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(evolution.runCardEvolution.mock.calls[0][0].directionEval?.mode).toBe(
        "migrate",
      );
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
      evolutionLoop.store.readDirection.mockResolvedValue(null);
    }
  });

  it("BOOTSTRAP is due only with material at hand: fitness events fire the run, an empty store does not", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    // readDirection stays null → bootstrap mode.
    try {
      // No material: no events, no legacy Self-model lines → no run.
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).not.toHaveBeenCalled();

      // Material: one fitness event → the FIRST direction is due.
      evolutionLoop.store.readFitness.mockResolvedValue({
        events: [
          {
            ts: "2026-07-14T09:00:00Z",
            sliceId: "2026-07-14-0900",
            bucket: "recall" as const,
            delta: -1 as const,
            evidence: "not what we discussed",
          },
        ],
        signals: [],
        directionRejections: [],
      });
      setupClosingSlice();
      mockAnalysis({ worth: false, reason: "pure logistics" });
      await housekeeping(makeInput("wrapping up again"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(evolution.runCardEvolution.mock.calls[0][0].directionEval?.mode).toBe(
        "bootstrap",
      );
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
      evolutionLoop.store.readFitness.mockResolvedValue({
        events: [],
        signals: [],
        directionRejections: [],
      });
    }
  });

  it("a REJECTED direction proposal rides the terminal frame as direction.rejected and backs the gate off on the ACTIVE slice", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    evolutionLoop.store.readDirection.mockResolvedValue(
      "# Direction\n\nBe concrete.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-07-14-0900 — x\n\n# Log\n\n- entry",
    );
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: "reviewed",
      direction: { outcome: "rejected", summary: "no substantive content" },
    });
    try {
      await housekeeping(makeInput("wrapping up"));
      // The backoff is keyed to the ACTIVE (new) slice — its remaining turns
      // must not re-fire the migrate gate; the closed slice is done anyway.
      expect(evolutionLoop.store.recordDirectionRejection).toHaveBeenCalledWith(
        "2026-07-14-1000",
        expect.anything(),
      );
      // The terminal frame keeps the rejection distinguishable from a
      // deliberate no_change.
      const terminal = workflowMock.written
        .filter((c) => c.type === "data-evolution")
        .at(-1);
      expect(terminal?.data).toMatchObject({
        direction: { outcome: "rejected", summary: "no substantive content" },
      });
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
      evolutionLoop.store.readDirection.mockResolvedValue(null);
    }
  });

  it("the merged run's directionEval carries the card's legacy Self-model lines as the migration source", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "durable" });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n\n## Identity\n\n- Name: Alan\n\n## Self-model\n\n- Don't decompose emotional venting\n",
    );
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(
        evolution.runCardEvolution.mock.calls[0][0].directionEval?.cardSelfModel,
      ).toContain("Don't decompose emotional venting");
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
    }
  });

  it("persists the analyzer's fitness deltas via appendFitnessEvents, attributed to the closed slice", async () => {
    setupClosingSlice();
    episodic.analyzeTurn.mockResolvedValue({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
      fitness: [
        { bucket: "recall", delta: -2, evidence: "这根本不是我们聊过的内容" },
      ],
    });
    await housekeeping(makeInput("wrapping up"));
    expect(evolutionLoop.store.appendFitnessEvents).toHaveBeenCalledOnce();
    const [events, batch] = evolutionLoop.store.appendFitnessEvents.mock.calls[0];
    expect(events).toEqual([
      expect.objectContaining({
        sliceId: "2026-07-14-0900", // the CLOSED slice, not the new one
        bucket: "recall",
        delta: -2,
        evidence: "这根本不是我们聊过的内容",
      }),
    ]);
    expect(batch).toBeDefined();
  });

  it("streams throttled live thinking lines on data-evolution, one merged id", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "a durable preference was stated" });
    evolution.runCardEvolution.mockImplementationOnce(async (input) => {
      input.onProgress?.("reading");
      input.onEvolutionLine?.("比较卡片", "thinking"); // sent — first line
      input.onEvolutionLine?.("比较卡片中", "thinking"); // dropped — inside 40ms, longer
      await new Promise((r) => setTimeout(r, 60));
      input.onEvolutionLine?.("比较卡片中…", "thinking"); // sent — throttle elapsed
      input.onEvolutionLine?.("落笔", "writing"); // sent — stage change forces
      input.onProgress?.("reviewing");
      return { ran: true, changed: false, droppedRecent: 0, note: "reviewed" };
    });

    await housekeeping(makeInput("wrapping up"));

    const evo = workflowMock.written.filter((c) => c.type === "data-evolution");
    // The standalone streaming card: every evolution chunk shares ONE id.
    expect(evo.length).toBeGreaterThan(0);
    expect(evo.every((c) => c.id === "evolution")).toBe(true);

    const live = evo
      .map((c) => c.data as { live?: string; liveStage?: string })
      .filter((d) => d.live);
    expect(live.map((d) => d.live)).toEqual(["比较卡片", "比较卡片中…", "落笔"]);
    expect(live.map((d) => d.liveStage)).toEqual([
      "thinking",
      "thinking",
      "writing",
    ]);
    // Live frames ride the current phase step and keep the legacy running key.
    expect(live[0]).toMatchObject({
      running: true,
      status: "running",
      step: "reading",
    });

    // The terminal frame: status done, legacy keys intact.
    const terminal = evo.at(-1)!.data as Record<string, unknown>;
    expect(terminal).toMatchObject({
      running: false,
      status: "done",
      hasChanges: false,
      note: "reviewed",
    });
  });

  it("flags the terminal chunk partial when the pass was cut off", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "a durable preference was stated" });
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: true,
      droppedRecent: 0,
      note: "[partial] step limit reached without finish",
      summary: "记下了面试",
      partial: true,
    });

    await housekeeping(makeInput("wrapping up"));

    const terminal = workflowMock.written
      .filter((c) => c.type === "data-evolution")
      .at(-1);
    expect(terminal?.id).toBe("evolution");
    expect(terminal?.data).toMatchObject({
      status: "done",
      partial: true,
      hasChanges: true,
      summary: "记下了面试",
    });
  });

  it("terminal frame carries the trigger rows + direction verdict on a triggered boundary (v1.0)", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: false, reason: "pure logistics" }); // card gate OFF — the trigger alone forces the run
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "recall", reason: "net -4" },
    ]);
    // The direction verdict rides the merged run's result now (v1.1).
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: "reviewed",
      direction: { outcome: "no_change" },
    });
    try {
      await housekeeping(makeInput("wrapping up"));
      const terminal = workflowMock.written
        .filter((c) => c.type === "data-evolution")
        .at(-1);
      expect(terminal?.data).toMatchObject({
        status: "done",
        hasChanges: false, // checked, no updates — the calibration details still show
        triggers: [{ bucket: "recall", score: -4 }], // mocked bucketNetScore
        direction: { outcome: "no_change" },
      });
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
    }
  });

  it("surfaces an applied direction proposal as direction.updated with its summary", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "durable" });
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: "reviewed",
      direction: { outcome: "updated", summary: "direction v1" },
    });
    await housekeeping(makeInput("wrapping up"));
    const terminal = workflowMock.written
      .filter((c) => c.type === "data-evolution")
      .at(-1);
    expect(terminal?.data).toMatchObject({
      direction: { outcome: "updated", summary: "direction v1" },
    });
    // No bucket fired (analyzer-gated run) → no score rows.
    expect(
      (terminal?.data as { triggers?: unknown }).triggers,
    ).toBeUndefined();
  });

  it("surfaces a failed direction write as direction.failed with the reason — a failure is not a silent no_change", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "durable" });
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: "reviewed",
      direction: { outcome: "failed", summary: "worker timeout" },
    });
    await housekeeping(makeInput("wrapping up"));
    const terminal = workflowMock.written
      .filter((c) => c.type === "data-evolution")
      .at(-1);
    expect(terminal?.data).toMatchObject({
      direction: { outcome: "failed", summary: "worker timeout" },
    });
  });

  it("passes Phase-2 playbook writes through to the terminal frame", async () => {
    setupClosingSlice();
    mockAnalysis({ worth: true, reason: "durable" });
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: "reviewed",
      playbooks: [
        { agent: "recall", summary: "fewer unverified recall answers" },
      ],
    });
    await housekeeping(makeInput("wrapping up"));
    const terminal = workflowMock.written
      .filter((c) => c.type === "data-evolution")
      .at(-1);
    expect(terminal?.data).toMatchObject({
      status: "done",
      playbooks: [{ agent: "recall", summary: "fewer unverified recall answers" }],
    });
  });
});

describe("mid-turn evolution check (every turn, pre-reply)", () => {
  function setupActiveSlice() {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    return disk;
  }

  /** A genuine MID-TURN input: the client history remembers the slice's
   *  agent reply, so the context_lost close heuristic stays off. */
  function midTurnInput(msg: string, overrides: Partial<TurnInput> = {}) {
    return makeInput(msg, {
      modelMessages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "reply" },
      ] as TurnInput["modelMessages"],
      ...overrides,
    });
  }

  it("a mid-turn fitness trigger runs the merged evolution BEFORE the reply (no boundary)", async () => {
    setupActiveSlice();
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "interaction", reason: 'dissatisfaction signal in the just-scored slice: "你又没回答我的问题"' },
    ]);
    try {
      await housekeeping(midTurnInput("again?"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      const arg = evolution.runCardEvolution.mock.calls[0][0];
      expect(arg.signal).toBe("new_observation");
      expect(arg.triggeredBuckets).toEqual(["interaction"]);
      // The merged run evaluates the direction FIRST, even mid-turn…
      expect(arg.directionEval).toBeDefined();
      // …but the deep whole-slice review stays boundary-scoped.
      expect(arg.closedSliceId).toBeUndefined();
      expect(arg.sliceId).toBe("2026-07-14-0900"); // the ACTIVE slice
      // A visible terminal frame settles the evolution card.
      const terminal = workflowMock.written
        .filter((c) => c.type === "data-evolution")
        .at(-1);
      expect(terminal?.data).toMatchObject({ status: "done" });
      // A successful fitness-triggered run settles the generation (v0.9.2).
      expect(evolutionLoop.store.resetFitnessGeneration).toHaveBeenCalledOnce();
    } finally {
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
      evolutionLoop.store.resetFitnessGeneration.mockClear();
    }
  });

  it("a FAILED fitness-triggered run settles nothing — the pressure stays for next turn", async () => {
    setupActiveSlice();
    evolutionLoop.store.resetFitnessGeneration.mockClear();
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "interaction", reason: "generation net -6" },
    ]);
    evolution.runCardEvolution.mockResolvedValueOnce({
      ran: true,
      changed: false,
      droppedRecent: 0,
      note: "worker timeout",
      error: "worker timeout",
    });
    try {
      await housekeeping(midTurnInput("again?"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(evolutionLoop.store.resetFitnessGeneration).not.toHaveBeenCalled();
    } finally {
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
    }
  });

  it("a boundary turn with triggers runs the evolution exactly ONCE (no mid-turn double-run)", async () => {
    sliceAged = true;
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.analyzeTurn.mockResolvedValue({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
      evolveCard: { worth: false, reason: "pure logistics" },
      fitness: [{ bucket: "interaction", delta: -1, evidence: "你又没回答我的问题" }],
    });
    episodic.readCurrentPreviously.mockResolvedValue(
      "# Previously On\n\n_Active slice: 2026-07-14-0900 | Format: user card v2 | Updated: 2026-07-14T09:30:00.000Z_\n",
    );
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "interaction", reason: 'dissatisfaction signal: "你又没回答我的问题"' },
    ]);
    try {
      await housekeeping(makeInput("wrapping up"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
    } finally {
      episodic.readCurrentPreviously.mockResolvedValue("");
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
    }
  });

  it("no trigger and no gate mid-turn → no evolution run, no evolution chunks", async () => {
    setupActiveSlice();
    await housekeeping(midTurnInput("just chatting"));
    expect(evolution.runCardEvolution).not.toHaveBeenCalled();
    expect(
      workflowMock.written.filter((c) => c.type === "data-evolution"),
    ).toHaveLength(0);
  });

  it("a REJECTED direction proposal backs the migrate gate off for the REST of the slice (no per-turn rerun)", async () => {
    setupActiveSlice();
    // An old-skeleton direction doc → migrate mode: without the backoff this
    // gate would re-fire the full merged run on EVERY mid-turn check.
    evolutionLoop.store.readDirection.mockResolvedValue(
      "# Direction\n\nBe concrete.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-07-14-0900 — x\n\n# Log\n\n- entry",
    );
    try {
      // Turn 1: the gate fires; the merged run's proposal is REJECTED.
      evolution.runCardEvolution.mockResolvedValueOnce({
        ran: true,
        changed: false,
        droppedRecent: 0,
        note: "reviewed",
        direction: {
          outcome: "rejected",
          summary: 'missing the fixed "# Log" section',
        },
      });
      await housekeeping(midTurnInput("first"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(evolutionLoop.store.recordDirectionRejection).toHaveBeenCalledWith(
        "2026-07-14-0900", // the ACTIVE slice
        expect.anything(),
      );
      let terminal = workflowMock.written
        .filter((c) => c.type === "data-evolution")
        .at(-1);
      expect(terminal?.data).toMatchObject({
        direction: {
          outcome: "rejected",
          summary: 'missing the fixed "# Log" section',
        },
      });

      // Turn 2 (same slice, rejection now on record): NO rerun — a visible
      // skip chunk explains the backoff instead.
      workflowMock.written.length = 0;
      evolutionLoop.store.readFitness.mockResolvedValue({
        events: [],
        signals: [],
        directionRejections: ["2026-07-14-0900"],
      });
      await housekeeping(midTurnInput("second"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce(); // still once
      const evoChunks = workflowMock.written.filter(
        (c) => c.type === "data-evolution",
      );
      expect(evoChunks).toHaveLength(1);
      expect(evoChunks[0].data).toMatchObject({
        running: false,
        status: "done",
        hasChanges: false,
      });
      expect((evoChunks[0].data as { note: string }).note).toContain(
        "backed off",
      );
    } finally {
      evolutionLoop.store.readDirection.mockResolvedValue(null);
      evolutionLoop.store.readFitness.mockResolvedValue({
        events: [],
        signals: [],
        directionRejections: [],
      });
    }
  });

  it("the NEXT slice is not backed off — a rejection retires with its slice (new slice, new chance)", async () => {
    // Active slice B; the store records a rejection for the PREVIOUS slice A
    // only, and the direction doc is still the old skeleton.
    const disk = makeSlice({
      slice_id: "2026-07-14-1000",
      turns: [
        { timestamp: "t0", role: "user", content: "old" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    evolutionLoop.store.readDirection.mockResolvedValue(
      "# Direction\n\nBe concrete.\n\n# Anti-goals\n\nNo coaching.\n\n# Evidence\n\n- 2026-07-14-0900 — x\n\n# Log\n\n- entry",
    );
    evolutionLoop.store.readFitness.mockResolvedValue({
      events: [],
      signals: [],
      directionRejections: ["2026-07-14-0900"], // slice A — not this one
    });
    try {
      await housekeeping(midTurnInput("new slice, same old direction doc"));
      expect(evolution.runCardEvolution).toHaveBeenCalledOnce();
      expect(
        evolution.runCardEvolution.mock.calls[0][0].directionEval?.mode,
      ).toBe("migrate");
    } finally {
      evolutionLoop.store.readDirection.mockResolvedValue(null);
      evolutionLoop.store.readFitness.mockResolvedValue({
        events: [],
        signals: [],
        directionRejections: [],
      });
    }
  });

  it("demo mode never runs evolution — explicit update + fired trigger notwithstanding", async () => {
    setupActiveSlice();
    episodic.analyzeTurn.mockResolvedValue({
      messageTags: { reuse: [], create: [] },
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
      memoryUpdate: { content: "Always answer in Chinese" },
    });
    evolutionLoop.computeEvolutionTriggers.mockReturnValue([
      { bucket: "interaction", reason: "fired" },
    ]);
    try {
      await housekeeping(midTurnInput("记住：以后都用中文", { useDemo: true }));
      expect(evolution.runCardEvolution).not.toHaveBeenCalled();
      // Demo skips the trigger math itself too.
      expect(evolutionLoop.computeEvolutionTriggers).not.toHaveBeenCalled();
    } finally {
      evolutionLoop.computeEvolutionTriggers.mockReturnValue([]);
    }
  });

  it("feeds the direction Portrait section (capped) into the turn-analyzer as Task 7's rubric", async () => {
    setupActiveSlice();
    const portrait = "用户不喜欢感性的回答";
    evolutionLoop.store.readDirection.mockResolvedValue(
      `# Portrait\n\n${portrait}\n\n# Hypotheses\n\n- [proposed 2026-07-14-0900 · checked 2026-07-14-0900] guess — falsify if: x\n\n# Evidence\n\n# Log`,
    );
    try {
      await housekeeping(midTurnInput("hello"));
      const arg = episodic.analyzeTurn.mock.calls.at(-1)?.[0] as {
        portrait?: string;
      };
      // The Portrait body only — the hypotheses pool stays out of the rubric.
      expect(arg.portrait).toBe(portrait);
    } finally {
      evolutionLoop.store.readDirection.mockResolvedValue(null);
    }
  });

  it("caps the rubric at 4000 chars and omits it when the doc is missing/template", async () => {
    setupActiveSlice();
    evolutionLoop.store.readDirection.mockResolvedValue(
      `# Portrait\n\n${"p".repeat(5000)}\n\n# Hypotheses\n\n# Evidence\n\n# Log`,
    );
    try {
      await housekeeping(midTurnInput("hello"));
      let arg = episodic.analyzeTurn.mock.calls.at(-1)?.[0] as {
        portrait?: string;
      };
      expect(arg.portrait).toHaveLength(4000);
    } finally {
      evolutionLoop.store.readDirection.mockResolvedValue(null);
    }

    setupActiveSlice();
    // Template placeholder body ("_(Not set yet…") → no rubric.
    evolutionLoop.store.readDirection.mockResolvedValue(
      "# Portrait\n\n_(Not set yet — placeholder.)_\n\n# Hypotheses\n\n# Evidence\n\n# Log",
    );
    try {
      await housekeeping(midTurnInput("hello again"));
      const arg = episodic.analyzeTurn.mock.calls.at(-1)?.[0] as {
        portrait?: string;
      };
      expect(arg.portrait).toBeUndefined();
    } finally {
      evolutionLoop.store.readDirection.mockResolvedValue(null);
    }
  });
});

describe("cross-day continuity (readMostRecentClosedSlice)", () => {
  function contextSummaries(): string[] {
    const chunk = workflowMock.written.find(
      (c) =>
        c.type === "data-phase" &&
        (c.data as { phase: string; running: boolean }).phase === "context" &&
        (c.data as { running: boolean }).running === false,
    );
    return ((chunk?.data as { summaries?: string[] } | undefined)?.summaries ??
      []) as string[];
  }

  it("uses the newest CLOSED catalog entry — gap computed from its real end", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({
        slice_id: "2026-07-14-1300",
        turns: [{ timestamp: "t", role: "user", content: msg }],
      }),
    );
    episodic.readTimelineIndex.mockResolvedValue({
      _schema: 1,
      updated_at: "2026-07-14T10:00:00.000Z",
      slice_count: 2,
      needs_marking: 0,
      slices: [
        // The just-created active slice must NOT be picked as the reference.
        {
          id: "2026-07-14-1300",
          date: "2026-07-14",
          start: "2026-07-14T10:00:00.000Z",
          status: "active",
          focus: "",
          summary: "",
          tags: [],
          open_loops: [],
          decisions: [],
          strands: [],
          needs_marking: true,
        },
        {
          id: "2026-07-14-0700",
          date: "2026-07-14",
          start: "2026-07-14T07:00:00.000Z",
          end: "2026-07-14T07:30:00.000Z",
          status: "closed",
          focus: "morning planning",
          summary: "",
          tags: [],
          open_loops: [],
          decisions: [],
          strands: [],
          needs_marking: false,
        },
      ],
    } as never);

    // startedAtIso = 2026-07-14T10:00Z; last slice ended 07:30 → 2.5h gap.
    await housekeeping(makeInput("back again"));
    expect(contextSummaries().join(" ")).toContain("continuity: recent_return");
  });

  it("reports none when the catalog holds no closed slice", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    episodic.readTimelineIndex.mockResolvedValue({
      _schema: 1,
      updated_at: "2026-07-14T10:00:00.000Z",
      slice_count: 0,
      needs_marking: 0,
      slices: [],
    } as never);

    await housekeeping(makeInput("first ever"));
    expect(contextSummaries().join(" ")).toContain("continuity: none");
  });
});

describe("turn idempotency (workflow redelivery)", () => {
  const outcome: TurnOutcome = {
    text: "agent reply",
    finishReason: "stop",
    cognition: "",
  };

  it("does not re-append the user turn when housekeeping re-runs with the same turnId", async () => {
    // Disk state after a first run that committed but whose result was lost:
    // the user turn is already persisted, keyed by turnId.
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier", turnId: "prev-id" },
        { timestamp: "t1", role: "agent", content: "reply", turnId: "prev-id" },
        { timestamp: "t2", role: "user", content: "follow up", turnId: "test-id" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);

    // Include an assistant message so the context continuity check passes.
    const input = makeInput("follow up", {
      modelMessages: [
        { role: "assistant", content: "reply" },
      ] as unknown as TurnInput["modelMessages"],
    });
    const { slice } = await housekeeping(input);

    expect(slice.turns).toHaveLength(3);
    expect(
      slice.turns.filter((t) => t.role === "user" && t.turnId === "test-id"),
    ).toHaveLength(1);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("does not re-append the agent turn when finalizeTurn re-runs with the same turnId", async () => {
    const slice = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "hi", turnId: "test-id" },
        { timestamp: "t1", role: "agent", content: "agent reply", turnId: "test-id" },
      ],
    });

    await finalizeTurn(slice, outcome, "test-id");

    expect(slice.turns.filter((t) => t.role === "agent")).toHaveLength(1);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("stores exactly one user turn and one agent turn even when both steps are redelivered", async () => {
    // First delivery: fresh slice, user turn minted by createSlice.
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    const { slice } = await housekeeping(makeInput("hello world"));

    // Agent turn appended once, then the whole finalize step is redelivered
    // against the same slice state (same turnId).
    await finalizeTurn(slice, outcome, "test-id");
    await finalizeTurn(slice, outcome, "test-id");

    expect(slice.turns.filter((t) => t.role === "user")).toHaveLength(1);
    expect(slice.turns.filter((t) => t.role === "agent")).toHaveLength(1);
  });
});
