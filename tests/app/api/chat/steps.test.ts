import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput } from "@/lib/chat/turn-types";

// ── Mock the step dependencies ──────────────────────────────────────────

const episodic = vi.hoisted(() => ({
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
  generateGlobalTimeline: vi.fn(async () => "mock timeline"),
  readPreviously: vi.fn(async () => ""),
  writePreviously: vi.fn(async () => {}),
  ensurePreviously: vi.fn(async () => ""),
  writeAgentTimeline: vi.fn(async () => ({ path: "", created: false })),
  readAgentTimeline: vi.fn(async () => ""),
}));

const maintenance = vi.hoisted(() => ({
  applyMetadataUpdates: vi.fn((meta: Record<string, unknown>, updates: Record<string, unknown>) => {
    Object.assign(meta, updates);
  }),
  applyBeliefUpdates: vi.fn((content: string) => content),
}));

const flashMetadata = vi.hoisted(() => ({
  runMetadataUpdate: vi.fn(),
}));

const flashPreviously = vi.hoisted(() => ({
  runUpdatePreviously: vi.fn(),
}));

let timeSilent = false;

vi.mock("@/lib/episodic", () => episodic);
vi.mock("@/lib/episodic/slicer", () => ({
  checkTimeSilence: () => timeSilent,
}));
vi.mock("@/lib/episodic/maintenance", () => maintenance);
vi.mock("@/lib/episodic/flash/metadata", () => flashMetadata);
vi.mock("@/lib/episodic/flash/update-previously", () => flashPreviously);

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
vi.mock("@/lib/identity", () => ({
  buildAgentIdentityPrompt: () => "identity prompt",
  loadUserProfile: async () => ({ name: "Test" }),
}));

import { housekeeping, metadataUpdate, updatePreviously, finalizeTurn } from "@/app/api/chat/steps";

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

function makeInput(lastUserMessage: string): TurnInput {
  return {
    modelMessages: [],
    recentTurns: [],
    lastUserMessage,
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "medium" as const,
    clientTimezone: "UTC",
    config: {
      slicing: { maxTurnsPerSlice: 40, timeSilenceMinutes: 30 },
      context: { recentTurnsLimit: 20, tokenBudget: 12000 },
      model: { provider: "deepseek-v4-flash", thinking: true, reasoningEffort: "medium" as const },
    },
    owner: "local",
    repo: "local",
    useGithub: false,
    useDemo: false,
    startedAtIso: "2026-07-14T10:00:00.000Z",
    turnId: "test-id",
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
    expect(workflowMock.written.map((c) => c.type)).toEqual(["data-phase", "start", "start-step", "data-phase"]);
  });

  it("restores an active slice and appends the new user turn", async () => {
    const disk = makeSlice({
      turns: [
        { timestamp: "t0", role: "user", content: "earlier" },
        { timestamp: "t1", role: "agent", content: "reply" },
      ],
    });
    episodic.tryLoadTodaySlice.mockResolvedValue(disk);

    const { slice } = await housekeeping(makeInput("follow up"));

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
});

describe("metadataUpdate step", () => {
  it("applies Flash metadata updates onto the slice and returns it by value", async () => {
    const slice = makeSlice();
    flashMetadata.runMetadataUpdate.mockResolvedValue({
      needs_metadata_update: true,
      metadata_updates: { focus: "rust borrow checker", tags: ["rust"] },
      reasoning: "matched",
    });

    const result = await metadataUpdate(makeInput("rust question"), slice);

    expect(result.slice.focus).toBe("rust borrow checker");
    expect(result.slice.tags).toContain("rust");
    expect(result.metadataUpdated).toBe(true);
  });

  it("degrades gracefully when Flash throws — slice untouched", async () => {
    const slice = makeSlice({ focus: "unchanged" });
    flashMetadata.runMetadataUpdate.mockRejectedValue(new Error("flash down"));

    const result = await metadataUpdate(makeInput("anything"), slice);

    expect(result.metadataUpdated).toBe(false);
    expect(result.slice.focus).toBe("unchanged");
  });
});

describe("updatePreviously step", () => {
  it("updates previously.md with observed beliefs", async () => {
    const slice = makeSlice();
    flashPreviously.runUpdatePreviously.mockResolvedValue({
      belief_updates: [{ action: "observe", section: "User identity", belief: "测试用户", evidence_turn: "test-id" }],
      reasoning: "observed",
      isDeep: false,
    });
    episodic.readPreviously.mockResolvedValue("## User identity\n\n## User patterns\n\n## Agent strategies\n");

    const result = await updatePreviously(makeInput("我叫测试"), slice, undefined);

    expect(result.beliefUpdates).toHaveLength(1);
    expect(episodic.writePreviously).toHaveBeenCalled();
  });

  it("degrades gracefully when Flash throws — empty updates", async () => {
    const slice = makeSlice();
    flashPreviously.runUpdatePreviously.mockRejectedValue(new Error("flash down"));
    episodic.readPreviously.mockResolvedValue("");

    const result = await updatePreviously(makeInput("anything"), slice, undefined);

    expect(result.beliefUpdates).toEqual([]);
    expect(result.previouslyContent).toBe("");
  });
});
