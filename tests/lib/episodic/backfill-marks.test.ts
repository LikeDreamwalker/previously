import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

const io = vi.hoisted(() => ({
  fsReadFile: vi.fn(),
  // Mirror the real batch semantics: queue into batch.entries when given one.
  fsWriteFile: vi.fn(
    async (
      path: string,
      content: string,
      batch?: { entries: Map<string, string> },
    ) => {
      if (batch) batch.entries.set(path, content);
      return { path, created: true };
    },
  ),
  fsListFiles: vi.fn(),
}));
vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/episodic/io-helpers")>();
  return { ...actual, ...io };
});

import {
  backfillDrySliceMarks,
  BACKFILL_MAX_PER_TURN,
} from "@/lib/episodic/flash/backfill-marks";
import type { ModelConfig } from "@/lib/models/registry";
import type { TimelineIndex } from "@/lib/episodic/timeline/types";
import type { WriteBatch } from "@/lib/episodic/io-helpers";

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

function sliceMd(id: string): string {
  return [
    "---",
    `slice_id: ${id}`,
    "status: closed",
    `start: "${id.slice(0, 10)}T00:00:00.000Z"`,
    "timezone: UTC",
    "---",
    "",
    "## Turn a1 — 2026-01-01T00:00:00.000Z (user)",
    "",
    "let's plan the launch",
    "",
    "## Turn a1 — 2026-01-01T00:01:00.000Z (agent)",
    "",
    "sure, here is the plan",
  ].join("\n");
}

function entry(id: string, dry: boolean) {
  return {
    id,
    date: id.slice(0, 10),
    start: `${id.slice(0, 10)}T00:00:00.000Z`,
    status: "closed" as const,
    focus: dry ? "" : "marked focus",
    summary: dry ? "" : "marked summary",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: dry,
  };
}

function indexWith(ids: Array<{ id: string; dry: boolean }>): TimelineIndex {
  return {
    _schema: 1,
    updated_at: "2026-08-01T00:00:00.000Z",
    slice_count: ids.length,
    needs_marking: ids.filter((s) => s.dry).length,
    slices: ids.map((s) => entry(s.id, s.dry)),
  };
}

/** Route fsReadFile by path: the catalog, or a slice's core.md. */
function mockReads(idx: TimelineIndex | null) {
  io.fsReadFile.mockImplementation(async (path: string) => {
    if (path === "memory/episodic/timeline/index.json") {
      if (!idx) throw new Error("ENOENT");
      return JSON.stringify(idx);
    }
    const m = path.match(
      /^memory\/episodic\/slices\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/timeline\/core\.md$/,
    );
    if (m) return sliceMd(`${m[1]}-${m[2]}-${m[3]}-${m[4]}`);
    throw new Error(`unexpected read: ${path}`);
  });
}

/** A StreamTextResult stand-in resolving to the given tool calls. */
function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

function mockMarking(focus = "Launch planning", summary = "Planned the launch") {
  ai.streamText.mockResolvedValue(
    streamWith([{ toolName: "markOutput", input: { focus, summary } }]),
  );
}

const batch = (): WriteBatch => ({ entries: new Map<string, string>() });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backfillDrySliceMarks", () => {
  it("marks a dry slice: frontmatter write + catalog refresh in the batch", async () => {
    mockReads(indexWith([{ id: "2026-01-01-0000", dry: true }]));
    mockMarking();
    const b = batch();

    const marked = await backfillDrySliceMarks({
      model,
      excludeSliceIds: [],
      batch: b,
    });

    expect(marked).toBe(1);
    // Slice frontmatter got the marks (body preserved).
    const core = b.entries.get(
      "memory/episodic/slices/2026/01/01/0000/timeline/core.md",
    );
    expect(core).toContain("focus: Launch planning");
    expect(core).toContain("summary: Planned the launch");
    expect(core).toContain("## Turn a1 — 2026-01-01T00:00:00.000Z (user)");
    // The catalog entry was refreshed and the index rewritten.
    const idxRaw = b.entries.get("memory/episodic/timeline/index.json");
    expect(idxRaw).toBeDefined();
    const idx = JSON.parse(idxRaw!) as TimelineIndex;
    expect(idx.slices[0].focus).toBe("Launch planning");
    expect(idx.slices[0].needs_marking).toBe(false);
    expect(idx.needs_marking).toBe(0);
    // The markdown projection was refreshed too.
    expect(b.entries.has("memory/episodic/timeline.md")).toBe(true);
  });

  it("never touches excluded (active / just-closed) slices", async () => {
    mockReads(indexWith([{ id: "2026-01-01-0000", dry: true }]));
    mockMarking();

    const marked = await backfillDrySliceMarks({
      model,
      excludeSliceIds: ["2026-01-01-0000"],
      batch: batch(),
    });

    expect(marked).toBe(0);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("is bounded at BACKFILL_MAX_PER_TURN candidates", async () => {
    const many = Array.from({ length: BACKFILL_MAX_PER_TURN + 2 }, (_, i) => ({
      id: `2026-01-0${i + 1}-0000`,
      dry: true,
    }));
    mockReads(indexWith(many));
    mockMarking();

    const marked = await backfillDrySliceMarks({
      model,
      excludeSliceIds: [],
      batch: batch(),
    });

    expect(marked).toBe(BACKFILL_MAX_PER_TURN);
    expect(ai.streamText).toHaveBeenCalledTimes(BACKFILL_MAX_PER_TURN);
  });

  it("returns 0 when there is no catalog yet", async () => {
    mockReads(null);
    const marked = await backfillDrySliceMarks({
      model,
      excludeSliceIds: [],
      batch: batch(),
    });
    expect(marked).toBe(0);
  });

  it("skips a slice whose marking fails and still marks the rest", async () => {
    mockReads(
      indexWith([
        { id: "2026-01-01-0000", dry: true },
        { id: "2026-01-02-0000", dry: true },
      ]),
    );
    ai.streamText
      .mockRejectedValueOnce(new Error("worker down"))
      .mockResolvedValueOnce(
        streamWith([
          { toolName: "markOutput", input: { focus: "F2", summary: "S2" } },
        ]),
      );
    const b = batch();

    const marked = await backfillDrySliceMarks({
      model,
      excludeSliceIds: [],
      batch: b,
    });

    expect(marked).toBe(1);
    expect(
      b.entries.has("memory/episodic/slices/2026/01/01/0000/timeline/core.md"),
    ).toBe(false);
    expect(
      b.entries.get("memory/episodic/slices/2026/01/02/0000/timeline/core.md"),
    ).toContain("focus: F2");
  });

  it("never throws even when reads explode", async () => {
    io.fsReadFile.mockRejectedValue(new Error("boom"));
    await expect(
      backfillDrySliceMarks({ model, excludeSliceIds: [], batch: batch() }),
    ).resolves.toBe(0);
  });
});
