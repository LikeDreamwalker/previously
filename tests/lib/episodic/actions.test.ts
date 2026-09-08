/**
 * v0.10 server actions — catalog-derived pagination (getSlicePageWithContent)
 * and the arrival gate (getArrivalState).
 *
 * The data layer is mocked at the module boundary: readTimelineIndex (catalog),
 * loadSlice (slice bodies), loadUserConfig (slicing knobs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { TimeSlice, Turn } from "@/lib/episodic/types";

const mocks = vi.hoisted(() => ({
  readTimelineIndex: vi.fn(),
  loadSlice: vi.fn(),
  loadUserConfig: vi.fn(),
  setDemoPersona: vi.fn(),
}));

vi.mock("@/lib/demo/demo-fs", () => ({
  getDemoPersona: vi.fn(() => "user"),
  listDemoPersonas: vi.fn(async () => []),
  setDemoPersona: mocks.setDemoPersona,
}));

vi.mock("@/lib/episodic/timeline/store", () => ({
  readTimelineIndex: mocks.readTimelineIndex,
}));

vi.mock("@/lib/episodic/manager", () => ({
  readSliceIndex: vi.fn(),
  readSliceBody: vi.fn(),
  parseSlice: vi.fn(),
  sliceIdToFilePath: vi.fn(),
  readPreviously: vi.fn(),
  readAgentTimeline: vi.fn(),
  loadSlice: mocks.loadSlice,
}));

vi.mock("@/lib/config/loader", () => ({
  loadUserConfig: mocks.loadUserConfig,
  invalidateUserConfigCache: vi.fn(),
}));

import {
  getSlicePageWithContent,
  getArrivalState,
  getStrandList,
} from "@/lib/episodic/actions";

// ─── Fixtures ────────────────────────────────────────────────────────────

let seq = 0;
function makeEntry(overrides: Partial<TimelineSliceEntry> = {}): TimelineSliceEntry {
  seq += 1;
  const hh = String(seq).padStart(2, "0");
  const id = `2026-08-11-10${hh}`;
  return {
    id,
    date: "2026-08-11",
    start: `2026-08-11T10:${hh}:00.000Z`,
    end: `2026-08-11T10:${hh}:20.000Z`,
    turn_count: 2,
    status: "closed",
    focus: `focus ${id}`,
    summary: `summary ${id}`,
    tags: ["t"],
    open_loops: [],
    decisions: [],
    strands: ["s"],
    needs_marking: false,
    ...overrides,
  };
}

function makeTurn(content: string, timestamp: string, role: "user" | "agent" = "user"): Turn {
  return { timestamp, role, content };
}

function makeSlice(entry: TimelineSliceEntry, turns: Turn[]): TimeSlice {
  return {
    slice_id: entry.id,
    focus: entry.focus,
    status: entry.status,
    start: entry.start,
    end: entry.end,
    timezone: "UTC",
    summary: entry.summary,
    open_loops: [],
    decisions: [],
    tags: entry.tags,
    related_slices: [],
    loops: [],
    turns,
    estimatedTokens: 0,
  };
}

/** Seed a catalog (oldest → newest) whose slice files all load with 2 turns. */
function seedCatalog(count: number): TimelineSliceEntry[] {
  const entries = Array.from({ length: count }, () => makeEntry());
  mocks.readTimelineIndex.mockResolvedValue({
    _schema: 1,
    updated_at: "2026-08-12T00:00:00.000Z",
    slice_count: entries.length,
    needs_marking: 0,
    slices: entries,
  });
  mocks.loadSlice.mockImplementation(async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return null;
    return makeSlice(entry, [
      makeTurn(`user in ${id}`, entry.start),
      makeTurn(`agent in ${id}`, entry.end ?? entry.start, "agent"),
    ]);
  });
  return entries;
}

beforeEach(() => {
  seq = 0;
  vi.clearAllMocks();
  mocks.loadUserConfig.mockResolvedValue({
    slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: 30 },
  });
});

// ─── getSlicePageWithContent ─────────────────────────────────────────────

describe("getSlicePageWithContent", () => {
  it("returns the newest page oldest→newest with turns filled in, hasMore exact", async () => {
    const entries = seedCatalog(5);

    const page = await getSlicePageWithContent(null, 3);

    expect(page.slices.map((s) => s.id)).toEqual(
      entries.slice(2).map((e) => e.id),
    );
    expect(page.hasMore).toBe(true);
    const first = page.slices[0];
    expect(first.turns).toHaveLength(2);
    expect(first.turnCount).toBe(2);
    expect(first.focus).toBe(entries[2].focus);
    expect(first.strands).toEqual(["s"]);
  });

  it("pages backwards from the `before` cursor (exclusive) and ends with hasMore false", async () => {
    const entries = seedCatalog(5);
    const firstPage = await getSlicePageWithContent(null, 3);

    const secondPage = await getSlicePageWithContent(firstPage.slices[0].start, 3);

    expect(secondPage.slices.map((s) => s.id)).toEqual(
      entries.slice(0, 2).map((e) => e.id),
    );
    expect(secondPage.hasMore).toBe(false);
  });

  it("reports hasMore false when the eligible catalog exactly fills the page", async () => {
    seedCatalog(3);
    const page = await getSlicePageWithContent(null, 3);
    expect(page.slices).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("returns an empty page for an empty / missing catalog", async () => {
    mocks.readTimelineIndex.mockResolvedValue(null);
    const page = await getSlicePageWithContent(null, 10);
    expect(page).toEqual({ slices: [], hasMore: false });

    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 0, needs_marking: 0, slices: [],
    });
    const page2 = await getSlicePageWithContent(null, 10);
    expect(page2).toEqual({ slices: [], hasMore: false });
  });

  it("skips phantom catalog entries whose slice file is missing", async () => {
    const entries = seedCatalog(3);
    mocks.loadSlice.mockImplementation(async (id: string) =>
      id === entries[1].id
        ? null
        : makeSlice(
            entries.find((e) => e.id === id)!,
            [makeTurn("x", entries[0].start)],
          ),
    );

    const page = await getSlicePageWithContent(null, 3);
    expect(page.slices.map((s) => s.id)).toEqual([entries[0].id, entries[2].id]);
    expect(page.hasMore).toBe(false);
  });

  it("carries continuesFrom / closedBy from the catalog entry", async () => {
    const entry = makeEntry({ continues_from: "2026-08-11-0958", closed_by: "time_cap" });
    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 1, needs_marking: 0, slices: [entry],
    });
    mocks.loadSlice.mockResolvedValue(makeSlice(entry, [makeTurn("x", entry.start)]));

    const page = await getSlicePageWithContent(null, 10);
    expect(page.slices[0].continuesFrom).toBe("2026-08-11-0958");
    expect(page.slices[0].closedBy).toBe("time_cap");
  });

  it("forwards the demo persona (same convention as getSliceContent)", async () => {
    seedCatalog(1);
    await getSlicePageWithContent(null, 10, "alice");
    expect(mocks.setDemoPersona).toHaveBeenCalledWith("alice");

    mocks.setDemoPersona.mockClear();
    await getSlicePageWithContent(null, 10);
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
  });
});

// ─── getArrivalState ─────────────────────────────────────────────────────

describe("getArrivalState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function seedLastSlice(turns: Turn[], overrides: Partial<TimeSlice> = {}) {
    const entry = makeEntry({ status: "active", end: undefined });
    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 1, needs_marking: 0, slices: [entry],
    });
    mocks.loadSlice.mockResolvedValue({
      ...makeSlice(entry, turns),
      ...overrides,
    });
    return entry;
  }

  it("resumes when the last turn is younger than the idle gap", async () => {
    const turns = [
      makeTurn("hi", "2026-08-11T11:40:00.000Z"),
      makeTurn("hello", "2026-08-11T11:45:00.000Z", "agent"),
    ];
    const entry = seedLastSlice(turns);

    const state = await getArrivalState();

    expect(state.mode).toBe("resume");
    if (state.mode === "resume") {
      expect(state.sliceId).toBe(entry.id);
      expect(state.turns).toEqual(turns);
      expect(state.focus).toBe(entry.focus);
      expect(state.start).toBe(entry.start);
    }
  });

  it("briefs when the last turn is older than the idle gap", async () => {
    seedLastSlice([makeTurn("old", "2026-08-11T11:00:00.000Z")]);
    const state = await getArrivalState();
    expect(state.mode).toBe("briefing");
  });

  it("briefs at exactly the idle-gap boundary (the slicer closes on >=)", async () => {
    // 30 min gap, last turn exactly 30 min ago — checkIdleGap closes on >=,
    // so the arrival gate must agree (strictly younger = resume).
    seedLastSlice([makeTurn("edge", "2026-08-11T11:30:00.000Z")]);
    const state = await getArrivalState();
    expect(state.mode).toBe("briefing");
  });

  it("follows a custom idleGapMinutes from the user config", async () => {
    mocks.loadUserConfig.mockResolvedValue({
      slicing: { maxSliceMinutes: 30, maxTurnsPerSlice: 50, idleGapMinutes: 120 },
    });
    seedLastSlice([makeTurn("old", "2026-08-11T11:00:00.000Z")]); // 60 min ago
    const state = await getArrivalState();
    expect(state.mode).toBe("resume");
  });

  it("briefs on an empty catalog or a missing slice file", async () => {
    mocks.readTimelineIndex.mockResolvedValue(null);
    expect((await getArrivalState()).mode).toBe("briefing");

    const entry = makeEntry();
    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 1, needs_marking: 0, slices: [entry],
    });
    mocks.loadSlice.mockResolvedValue(null);
    expect((await getArrivalState()).mode).toBe("briefing");
  });

  it("falls back to end, then start, when the slice has no turns", async () => {
    // No turns: end is 20 min ago → resume.
    const entry = makeEntry({ end: "2026-08-11T11:40:00.000Z" });
    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 1, needs_marking: 0, slices: [entry],
    });
    mocks.loadSlice.mockResolvedValue(makeSlice(entry, []));
    expect((await getArrivalState()).mode).toBe("resume");

    // No turns, no end: start is 2 h ago → briefing.
    const old = makeEntry({ start: "2026-08-11T10:00:00.000Z", end: undefined });
    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 1, needs_marking: 0, slices: [old],
    });
    mocks.loadSlice.mockResolvedValue(makeSlice(old, []));
    expect((await getArrivalState()).mode).toBe("briefing");
  });

  it("forwards the demo persona", async () => {
    seedLastSlice([makeTurn("hi", "2026-08-11T11:50:00.000Z")]);
    await getArrivalState("alice");
    expect(mocks.setDemoPersona).toHaveBeenCalledWith("alice");

    mocks.setDemoPersona.mockClear();
    await getArrivalState();
    expect(mocks.setDemoPersona).not.toHaveBeenCalled();
  });
});

describe("getStrandList", () => {
  it("aggregates counts and sorts by most recent activity", async () => {
    mocks.readTimelineIndex.mockResolvedValue({
      _schema: 1, updated_at: "", slice_count: 3, needs_marking: 0,
      slices: [
        makeEntry({ id: "2026-08-11-1000", date: "2026-08-11", start: "2026-08-11T10:00:00.000Z", strands: ["running", "work"] }),
        makeEntry({ id: "2026-08-12-1000", date: "2026-08-12", start: "2026-08-12T10:00:00.000Z", strands: ["running"] }),
        makeEntry({ id: "2026-08-13-1000", date: "2026-08-13", start: "2026-08-13T10:00:00.000Z", strands: ["work"] }),
      ],
    });
    expect(await getStrandList()).toEqual([
      { name: "work", count: 2, lastStart: "2026-08-13T10:00:00.000Z" },
      { name: "running", count: 2, lastStart: "2026-08-12T10:00:00.000Z" },
    ]);
  });

  it("returns an empty list when the catalog is missing", async () => {
    mocks.readTimelineIndex.mockResolvedValue(null);
    expect(await getStrandList()).toEqual([]);
  });
});
