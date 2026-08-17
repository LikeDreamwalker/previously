/**
 * Granular memory tools (v0.8) — readSliceSummary (frontmatter only) and
 * readTimelineWindow (catalog over a date window). Local mode; the read layer
 * is an in-memory Map.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const local = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    readFileLocal: async (p: string) => {
      if (!files.has(p)) throw new Error(`File not found: "${p}"`);
      return files.get(p)!;
    },
  };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: (p: string) => local.readFileLocal(p),
  listFilesLocal: vi.fn(async () => []),
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  invalidateReadCache: vi.fn(),
  __resetReadCache: vi.fn(),
}));
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: vi.fn(async () => {
    throw new Error("demo read should not be called in local mode");
  }),
  listFilesDemo: vi.fn(async () => []),
}));

import {
  readSliceSummaryExecute,
  readTimelineWindowExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId: "2026-08-11-1115",
    recentTurns: [],
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

/** The executor's second argument — ExecuteOpts<ToolContext> needs toolCallId. */
function opts(overrides: Partial<ToolContext> = {}): {
  context: ToolContext;
  toolCallId: string;
} {
  return { context: makeCtx(overrides), toolCallId: "tc1" };
}

const CORE_PATH =
  "memory/episodic/slices/2026/08/11/1115/timeline/core.md";

function seedSlice(): void {
  local.files.set(
    CORE_PATH,
    [
      "---",
      "slice_id: 2026-08-11-1115",
      "status: closed",
      "start: '2026-08-11T11:15:15.117Z'",
      "focus: '回顾滴滴时期绩效背锅'",
      "summary: '用户倾诉滴滴经历，探讨平行宇宙'",
      "tags:",
      "  - 状态回忆",
      "  - 创伤克服",
      "emotional_tone: mixed",
      "---",
      "",
      "## Turn t1 — 2026-08-11T11:15:15.117Z (user)",
      "",
      "第一轮",
      "",
      "## Turn t2 — 2026-08-11T11:20:00.000Z (agent)",
      "",
      "第二轮",
    ].join("\n"),
  );
}

beforeEach(() => {
  local.files.clear();
});

describe("readSliceSummaryExecute", () => {
  it("returns frontmatter fields + turn count (not the body)", async () => {
    seedSlice();
    const out = await readSliceSummaryExecute(
      { sliceId: "2026-08-11-1115" },
      opts(),
    );
    expect(out).toContain("slice 2026-08-11-1115");
    expect(out).toContain("回顾滴滴时期绩效背锅");
    expect(out).toContain("用户倾诉滴滴经历，探讨平行宇宙");
    expect(out).toContain("状态回忆; 创伤克服");
    expect(out).toContain("turns: 2");
    expect(out).not.toContain("第一轮"); // never the body
  });

  it("rejects an invalid slice id", async () => {
    const out = await readSliceSummaryExecute(
      { sliceId: "not-a-slice" },
      opts(),
    );
    expect(out).toContain("ERROR");
  });

  it("errors when the slice does not exist", async () => {
    const out = await readSliceSummaryExecute(
      { sliceId: "2026-08-11-9999" },
      opts(),
    );
    expect(out).toContain("ERROR");
  });
});

describe("readTimelineWindowExecute", () => {
  const INDEX_PATH = "memory/episodic/timeline/index.json";

  function seedIndex(): void {
    local.files.set(
      INDEX_PATH,
      JSON.stringify({
        _schema: 1,
        updated_at: "2026-08-12T00:00:00.000Z",
        slice_count: 2,
        needs_marking: 0,
        slices: [
          {
            id: "2026-08-11-1115",
            date: "2026-08-11",
            start: "2026-08-11T11:15:15.117Z",
            status: "closed",
            focus: "回顾滴滴时期绩效背锅",
            summary: "…",
            tags: ["状态回忆"],
            strands: [],
            needs_marking: false,
          },
          {
            id: "2026-08-10-1839",
            date: "2026-08-10",
            start: "2026-08-10T18:39:01.366Z",
            status: "closed",
            focus: "地址研究",
            summary: "…",
            tags: [],
            strands: [],
            needs_marking: false,
          },
        ],
      }),
    );
  }

  it("filters the catalog by date window and renders pointer lines", async () => {
    seedIndex();
    const out = await readTimelineWindowExecute(
      { from: "2026-08-11", to: "2026-08-11" },
      opts(),
    );
    expect(out).toContain("2026-08-11-1115");
    expect(out).toContain("回顾滴滴时期绩效背锅");
    expect(out).not.toContain("2026-08-10-1839"); // outside window
  });

  it("omitting the window returns the recent slice first", async () => {
    seedIndex();
    const out = await readTimelineWindowExecute({}, opts());
    expect(out.indexOf("2026-08-11-1115")).toBeLessThan(out.indexOf("2026-08-10-1839"));
  });

  it("degrades gracefully when the catalog is missing", async () => {
    const out = await readTimelineWindowExecute({}, opts());
    expect(out).toContain("尚不可用");
  });
});
