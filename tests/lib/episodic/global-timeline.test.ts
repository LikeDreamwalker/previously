import { describe, it, expect, vi } from "vitest";
import {
  formatEntry,
  buildTimelineContent,
  type TimelineEntry,
} from "@/lib/episodic/flash/global-timeline";

// ─── Mock the I/O layer ──────────────────────────────────────────────────

// We mock ONLY the io-helpers module. The source file uses relative imports
// ("../io-helpers"), but vitest resolves by module ID, so the alias works.
const mockFsReadFile = vi.fn();
const mockFsWriteFile = vi.fn();

vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: (...args: unknown[]) => mockFsReadFile(...args),
  fsWriteFile: (...args: unknown[]) => mockFsWriteFile(...args),
  fsListFiles: vi.fn(async () => []),
}));

// We also mock manager for generateGlobalTimeline (calls readSliceIndex).
// Need to provide a mock that returns empty by default, overridden per-test.
const mockReadSliceIndex = vi.fn();

vi.mock("@/lib/episodic/manager", () => ({
  readSliceIndex: (...args: unknown[]) => mockReadSliceIndex(...args),
}));

// Now import the functions that depend on these mocks.
import {
  generateGlobalTimeline,
  updateGlobalTimeline,
} from "@/lib/episodic/flash/global-timeline";

// ─── Test data ────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    slice_id: "2026-07-24-1500",
    focus: "testing",
    summary: "A test session",
    tags: ["test", "vitest"],
    status: "closed",
    start: "2026-07-24T15:00:00.000Z",
    ...overrides,
  };
}

// ─── formatEntry ──────────────────────────────────────────────────────────

describe("formatEntry", () => {
  it("formats a full entry with all fields", () => {
    const result = formatEntry(makeEntry());
    expect(result).toContain("## 2026-07-24-1500");
    expect(result).toContain("- Focus: testing");
    expect(result).toContain("- Summary: A test session");
    expect(result).toContain("- Tags: test, vitest");
    expect(result).toContain("- Status: ⚫ closed");
    expect(result).toContain("- Start: 2026-07-24T15:00:00.000Z");
  });

  it('shows "(none)" for empty focus', () => {
    const result = formatEntry(makeEntry({ focus: "" }));
    expect(result).toContain("- Focus: (none)");
  });

  it('shows "(none)" for empty summary', () => {
    const result = formatEntry(makeEntry({ summary: "" }));
    expect(result).toContain("- Summary: (none)");
  });

  it('shows "untagged" for empty tags', () => {
    const result = formatEntry(makeEntry({ tags: [] }));
    expect(result).toContain("- Tags: untagged");
  });

  it("uses 🟡 for active status", () => {
    const result = formatEntry(makeEntry({ status: "active" }));
    expect(result).toContain("- Status: 🟡 active");
  });

  it("uses ⚫ for closed status", () => {
    const result = formatEntry(makeEntry({ status: "closed" }));
    expect(result).toContain("- Status: ⚫ closed");
  });
});

// ─── buildTimelineContent ─────────────────────────────────────────────────

describe("buildTimelineContent", () => {
  it("builds a header with generation timestamp and count", () => {
    const entries = [makeEntry(), makeEntry({ slice_id: "2026-07-24-1600" })];
    const result = buildTimelineContent(entries);

    expect(result).toContain("# Global Timeline Index");
    expect(result).toMatch(/_Generated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_/);
    expect(result).toContain("_Total slices: 2_");
    expect(result).toContain("---");
  });

  it("includes all entry bodies in order", () => {
    const entries = [
      makeEntry({ slice_id: "2026-07-24-1700", start: "2026-07-24T17:00:00.000Z" }),
      makeEntry({ slice_id: "2026-07-24-1500", start: "2026-07-24T15:00:00.000Z" }),
    ];
    const result = buildTimelineContent(entries);
    const idx1700 = result.indexOf("## 2026-07-24-1700");
    const idx1500 = result.indexOf("## 2026-07-24-1500");
    expect(idx1700).toBeLessThan(idx1500);
  });

  it("handles zero entries", () => {
    const result = buildTimelineContent([]);
    expect(result).toContain("_Total slices: 0_");
    expect(result).toContain("---");
  });

  it("includes entry separator newlines", () => {
    const entries = [makeEntry(), makeEntry({ slice_id: "2026-07-25-0800" })];
    const result = buildTimelineContent(entries);
    expect(result).toContain("\n\n");
  });
});

// ─── generateGlobalTimeline ──────────────────────────────────────────────

describe("generateGlobalTimeline", () => {
  it("rebuilds from monthly indices and writes the result", async () => {
    const mockIndex = [
      {
        id: "2026-07-24-1500",
        focus: "test",
        summary: "a session",
        tags: ["qa"],
        status: "closed",
        start: "2026-07-24T15:00:00.000Z",
        open_loops: [],
        decisions: [],
      },
    ];

    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue(mockIndex);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    const result = await generateGlobalTimeline();

    expect(result).toContain("## 2026-07-24-1500");
    expect(result).toContain("- Tags: qa");
    expect(mockFsWriteFile).toHaveBeenCalledWith(
      "memory/episodic/timeline.md",
      result,
    );
  });

  it("handles missing indices gracefully (empty months)", async () => {
    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue([]);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    const result = await generateGlobalTimeline();
    expect(result).toContain("_Total slices: 0_");
  });

  it("deduplicates entries with the same slice_id", async () => {
    const dupEntry = {
      id: "2026-07-24-1500",
      focus: "dup",
      summary: "dup",
      tags: [],
      status: "closed",
      start: "2026-07-24T15:00:00.000Z",
      open_loops: [],
      decisions: [],
    };

    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue([dupEntry, dupEntry]);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    const result = await generateGlobalTimeline();
    const matches = [...result.matchAll(/## 2026-07-24-1500/g)];
    expect(matches).toHaveLength(1);
  });

  it("excludes active slices — the ongoing conversation is not a past memory", async () => {
    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue([
      {
        id: "2026-08-05-1644",
        focus: "active session",
        summary: "discussing apples right now",
        tags: ["apple"],
        status: "active",
        start: "2026-08-05T16:44:00.000Z",
        open_loops: [],
        decisions: [],
      },
      {
        id: "2026-07-24-1500",
        focus: "past session",
        summary: "shopping list",
        tags: ["groceries"],
        status: "closed",
        start: "2026-07-24T15:00:00.000Z",
        open_loops: [],
        decisions: [],
      },
    ]);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    const result = await generateGlobalTimeline();
    expect(result).toContain("## 2026-07-24-1500");
    expect(result).not.toContain("## 2026-08-05-1644");
    expect(result).not.toContain("discussing apples");
  });

  it("sorts entries newest first", async () => {
    const older = {
      id: "2026-07-24-1400",
      focus: "older",
      summary: "older",
      tags: [],
      status: "closed",
      start: "2026-07-24T14:00:00.000Z",
      open_loops: [],
      decisions: [],
    };
    const newer = {
      id: "2026-07-24-1600",
      focus: "newer",
      summary: "newer",
      tags: [],
      status: "closed",
      start: "2026-07-24T16:00:00.000Z",
      open_loops: [],
      decisions: [],
    };

    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue([older, newer]);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    const result = await generateGlobalTimeline();
    const idxNewer = result.indexOf("## 2026-07-24-1600");
    const idxOlder = result.indexOf("## 2026-07-24-1400");
    expect(idxNewer).toBeLessThan(idxOlder);
  });
});

// ─── updateGlobalTimeline ─────────────────────────────────────────────────

describe("updateGlobalTimeline", () => {
  const existingTimeline = [
    "# Global Timeline Index",
    "",
    "_Generated: 2026-07-24T12:00:00.000Z_",
    "_Total slices: 3_",
    "",
    "---",
    "",
    "## 2026-07-24-1500",
    "- Focus: foo",
    "- Summary: bar",
    "- Tags: x",
    "- Status: ⚫ closed",
    "- Start: 2026-07-24T15:00:00.000Z",
    "",
  ].join("\n");

  it("inserts a new entry after the header separator", async () => {
    mockFsReadFile.mockReset();
    mockFsReadFile.mockResolvedValue(existingTimeline);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    const entry: TimelineEntry = {
      slice_id: "2026-07-24-1600",
      focus: "new-entry",
      summary: "just added",
      tags: ["new"],
      status: "closed",
      start: "2026-07-24T16:00:00.000Z",
    };

    await updateGlobalTimeline(entry);

    const written = mockFsWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain("## 2026-07-24-1600");
    expect(written).toContain("- Focus: new-entry");
    const idxNew = written.indexOf("## 2026-07-24-1600");
    const idxOld = written.indexOf("## 2026-07-24-1500");
    expect(idxNew).toBeLessThan(idxOld);
  });

  it("increments the total slice count", async () => {
    mockFsReadFile.mockReset();
    mockFsReadFile.mockResolvedValue(existingTimeline);
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });

    await updateGlobalTimeline(makeEntry());

    const written = mockFsWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain("_Total slices: 4_"); // was 3, now 4
  });

  it("falls back to generateGlobalTimeline when file does not exist", async () => {
    mockFsReadFile.mockReset();
    mockFsReadFile.mockRejectedValue(new Error("File not found"));
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });
    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue([]);

    await updateGlobalTimeline(makeEntry());

    // Should have called fsWriteFile (via generateGlobalTimeline)
    expect(mockFsWriteFile).toHaveBeenCalled();
    const written = mockFsWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain("_Total slices: 0_");
  });

  it("falls back to generateGlobalTimeline when file is malformed (no separator)", async () => {
    mockFsReadFile.mockReset();
    mockFsReadFile.mockResolvedValue("garbage content with no separator");
    mockFsWriteFile.mockReset();
    mockFsWriteFile.mockResolvedValue({ path: "", created: false });
    mockReadSliceIndex.mockReset();
    mockReadSliceIndex.mockResolvedValue([]);

    // Should not throw
    await updateGlobalTimeline(makeEntry());
  });
});
