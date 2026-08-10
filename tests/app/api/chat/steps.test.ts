import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput } from "@/lib/chat/turn-types";

// ── Mock the step dependencies ──────────────────────────────────────────

const episodic = vi.hoisted(() => ({
  startBatch: vi.fn(() => {}),
  flushBatch: vi.fn(async (_msg: string) => {}),
  tryLoadTodaySlice: vi.fn(),
  createSlice: vi.fn((msg: string, tz: string) =>
    makeSlice({ turns: [{ timestamp: "t", role: "user", content: msg }] })
  ),
  closeSlice: vi.fn(),
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
  readStrands: vi.fn(async () => ({})),
  analyzeTurn: vi.fn(async () => ({
    messageTags: { reuse: [], create: [] },
    semanticHint: { strands: [], reason: "" },
    memoryWorthy: true,
    emotionalSignal: { intensity: "none", register: "neutral", note: "" },
  })),
}));

let timeSilent = false;

vi.mock("@/lib/episodic", () => episodic);
vi.mock("@/lib/episodic/slicer", () => ({
  checkTimeSilence: () => timeSilent,
}));

// Mock AI SDK for Flash tag extraction in housekeeping
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({ toolCalls: [] })),
  };
});

vi.mock("@ai-sdk/deepseek", () => ({
  deepseek: vi.fn((id: string) => ({ modelId: id })),
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
    workerModel: {
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
    config: {
      slicing: { maxTurnsPerSlice: 40, timeSilenceMinutes: 30 },
      context: { recentTurnsLimit: 20 },
      model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "medium" as const },
      worker: { mode: "auto" as const, provider: "" },
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-07-14T10:00:00.000Z",
    turnId: "test-id",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workflowMock.written.length = 0;
  timeSilent = false;
});

describe("housekeeping step", () => {
  it("creates a fresh slice when none is on disk and returns it by value", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    const { slice } = await housekeeping(makeInput("hello world"));

    expect(episodic.createSlice).toHaveBeenCalledWith("hello world", "UTC", "test-id");
    expect(slice.turns).toHaveLength(1);
    expect(slice.turns[0].content).toBe("hello world");
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice);
    expect(episodic.ensureIndexEntries).toHaveBeenCalledWith(slice);
    expect(episodic.appendTurn).not.toHaveBeenCalled();

    // 8 compact housekeeping phases (slice/tags/context/strands × running+done)
    // then the stream lifecycle chunks.
    expect(workflowMock.written.map((c) => c.type)).toEqual([
      ...Array(8).fill("data-phase"),
      "start",
      "start-step",
    ]);
    const phases = workflowMock.written
      .filter((c) => c.type === "data-phase")
      .map((c) => (c.data as { phase: string; running: boolean; compact?: boolean }));
    expect(phases.map((p) => `${p.phase}:${p.running}`)).toEqual([
      "slice:true",
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
    expect(episodic.saveSliceSnapshot).toHaveBeenCalledWith(slice);
  });

  it("closes a stale slice on time silence and starts a new one", async () => {
    timeSilent = true;
    const disk = makeSlice({ turns: [{ timestamp: "t0", role: "user", content: "old" }] });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);
    episodic.createSlice.mockImplementation((msg: string) =>
      makeSlice({ slice_id: "2026-07-14-1000", turns: [{ timestamp: "t", role: "user", content: msg }] })
    );

    const { slice } = await housekeeping(makeInput("new topic"));

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "time_silence");
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

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "capacity");
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

    expect(episodic.closeSlice).toHaveBeenCalledWith(disk, "context_lost");
    expect(slice.slice_id).toBe("2026-07-14-1200");
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
