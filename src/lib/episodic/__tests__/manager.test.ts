import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../io-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../io-helpers")>();
  return { ...actual, fsReadFile: vi.fn(), fsWriteFile: vi.fn(), fsListFiles: vi.fn() };
});

import { fsReadFile, fsWriteFile, fsListFiles } from "../io-helpers";
import {
  parseSlice,
  serializeSlice,
  toIndexEntry,
  sliceIdToRelPath,
  sliceIdToFilePath,
  sliceIdToTimelineDir,
  sliceIdToAgentPath,
  sliceIdToPreviouslyPath,
  emptyPreviouslyTemplate,
  readPreviously,
  ensurePreviously,
  readCurrentPreviously,
  writeCurrentPreviously,
  closeSlice,
  tryLoadTodaySlice,
} from "../manager";
import type { TimeSlice, Turn } from "../types";

// ─── Sample data ───────────────────────────────────────────────────────

const sampleTurns: Turn[] = [
  { timestamp: "2024-03-15T10:00:00.000Z", role: "user", content: "Hello, let's discuss the project.", turnId: "a3fk2w" },
  { timestamp: "2024-03-15T10:01:00.000Z", role: "agent", content: "Sure! What aspect of the project?", turnId: "a3fk2w" },
  { timestamp: "2024-03-15T10:02:00.000Z", role: "user", content: "The timeline and deliverables.", turnId: "b4gl3x" },
];

const sampleSlice: TimeSlice = {
  slice_id: "2024-03-15-1000",
  focus: "Project planning discussion",
  status: "closed",
  start: "2024-03-15T10:00:00.000Z",
  end: "2024-03-15T10:30:00.000Z",
  timezone: "America/Chicago",
  summary: "Discussed project timeline and deliverables for the corridor outreach program.",
  open_loops: ["Need to confirm budget numbers", "Follow up with Sharon about workshop schedule"],
  decisions: ["Use color-coded checklist format", "Schedule next review for Friday"],
  tags: ["work", "planning", "corridor-project"],
  related_slices: ["2024-03-08"],
  loops: [],
  emotional_tone: "neutral",
  turns: sampleTurns,
  estimatedTokens: 500,
  closedBy: "user_explicit",
};

// ─── serializeSlice ────────────────────────────────────────────────────

describe("serializeSlice", () => {
  it("produces valid markdown with YAML frontmatter", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("---");
    expect(md).toContain("2024-03-15"); // slice_id may be quoted
    expect(md).toContain("focus: Project planning discussion");
    expect(md).toContain("status: closed");
    expect(md).toContain("2024-03-15T10:00:00.000Z"); // start may be quoted
  });

  it("includes all turn headers in body with turnId labels", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("## Turn a3fk2w — 2024-03-15T10:00:00.000Z (user)");
    expect(md).toContain("## Turn a3fk2w — 2024-03-15T10:01:00.000Z (agent)");
    expect(md).toContain("## Turn b4gl3x — 2024-03-15T10:02:00.000Z (user)");
  });

  it("includes turn content after headers", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("Hello, let's discuss the project.");
    expect(md).toContain("Sure! What aspect of the project?");
  });

  it("includes list fields in frontmatter", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("open_loops:");
    expect(md).toContain("  - Need to confirm budget numbers");
    expect(md).toContain("decisions:");
    expect(md).toContain("  - Use color-coded checklist format");
    expect(md).toContain("tags:");
    expect(md).toContain("  - work");
  });

  it("omits undefined end field", () => {
    const noEnd = { ...sampleSlice, end: undefined };
    const md = serializeSlice(noEnd);
    expect(md).not.toContain("end:");
  });

  it("omits empty string fields", () => {
    const empty = { ...sampleSlice, focus: "", summary: "" };
    const md = serializeSlice(empty);
    // focus and summary are empty strings, should be omitted
    expect(md).not.toContain("focus: ");
    expect(md).not.toContain("summary: ");
  });

  it("handles slice with no turns", () => {
    const empty = { ...sampleSlice, turns: [] };
    const md = serializeSlice(empty);
    expect(md).toContain("---");
    // Body should be empty
    const parts = md.split("---\n");
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── parseSlice ────────────────────────────────────────────────────────

describe("parseSlice", () => {
  it("roundtrips: serialize → parse returns equivalent data", () => {
    const md = serializeSlice(sampleSlice);
    const parsed = parseSlice(md);

    expect(parsed.slice_id).toBe(sampleSlice.slice_id);
    expect(parsed.focus).toBe(sampleSlice.focus);
    expect(parsed.status).toBe(sampleSlice.status);
    expect(parsed.start).toBe(sampleSlice.start);
    expect(parsed.end).toBe(sampleSlice.end);
    expect(parsed.timezone).toBe(sampleSlice.timezone);
    expect(parsed.summary).toBe(sampleSlice.summary);
    expect(parsed.open_loops).toEqual(sampleSlice.open_loops);
    expect(parsed.decisions).toEqual(sampleSlice.decisions);
    expect(parsed.tags).toEqual(sampleSlice.tags);
    expect(parsed.emotional_tone).toBe(sampleSlice.emotional_tone);
  });

  it("roundtrips turns correctly with turnId", () => {
    const md = serializeSlice(sampleSlice);
    const parsed = parseSlice(md);

    expect(parsed.turns).toHaveLength(sampleTurns.length);
    expect(parsed.turns[0].timestamp).toBe(sampleTurns[0].timestamp);
    expect(parsed.turns[0].role).toBe(sampleTurns[0].role);
    expect(parsed.turns[0].content).toBe(sampleTurns[0].content);
    expect(parsed.turns[0].turnId).toBe("a3fk2w");
    expect(parsed.turns[1].turnId).toBe("a3fk2w");
    expect(parsed.turns[2].turnId).toBe("b4gl3x");
  });

  it("parses em-dash turn headers correctly", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Message one

## Turn 2 — 2024-01-01T00:01:00.000Z (agent)

Message two
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[1].role).toBe("agent");
  });

  it("handles empty body (no turns)", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: empty slice
open_loops: []
decisions: []
tags: []
---
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(0);
  });

  it("handles multi-paragraph turn content", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Paragraph one.

Paragraph two.

## Turn 2 — 2024-01-01T00:01:00.000Z (agent)

Single paragraph.
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].content).toContain("Paragraph one.");
    expect(parsed.turns[0].content).toContain("Paragraph two.");
  });

  it("defaults missing frontmatter fields", () => {
    const md = `---
slice_id: 2024-01-01
status: active
start: "2024-01-01T00:00:00.000Z"
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Hello
`;
    const parsed = parseSlice(md);
    expect(parsed.focus).toBe("");
    expect(parsed.summary).toBe("");
    expect(parsed.open_loops).toEqual([]);
    expect(parsed.decisions).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.timezone).toBe("UTC");
  });

  it("preserves markdown content in turns", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Here is a **bold** statement and a [link](https://example.com).

- list item 1
- list item 2
`;
    const parsed = parseSlice(md);
    expect(parsed.turns[0].content).toContain("**bold**");
    expect(parsed.turns[0].content).toContain("[link](https://example.com)");
    expect(parsed.turns[0].content).toContain("- list item 1");
  });
});

// ─── toIndexEntry ──────────────────────────────────────────────────────

describe("toIndexEntry", () => {
  it("uses full slice_id as id (YYYY-MM-DD-HHMM format)", () => {
    const entry = toIndexEntry(sampleSlice);
    expect(entry.id).toBe("2024-03-15-1000");
  });

  it("copies metadata fields correctly", () => {
    const entry = toIndexEntry(sampleSlice);
    expect(entry.focus).toBe(sampleSlice.focus);
    expect(entry.summary).toBe(sampleSlice.summary);
    expect(entry.tags).toEqual(sampleSlice.tags);
    expect(entry.status).toBe(sampleSlice.status);
    expect(entry.start).toBe(sampleSlice.start);
    expect(entry.open_loops).toEqual(sampleSlice.open_loops);
    expect(entry.decisions).toEqual(sampleSlice.decisions);
  });
});

// ─── sliceIdToRelPath / sliceIdToFilePath ──────────────────────────────

describe("sliceIdToRelPath", () => {
  it("maps a time-bearing id to a day-directory + HHMM path", () => {
    expect(sliceIdToRelPath("2026-07-10-1430")).toBe("2026/07/10/1430");
  });

  it("falls back to the legacy day path for a date-only id", () => {
    expect(sliceIdToRelPath("2026-07-10")).toBe("2026/07/10");
  });
});

describe("sliceIdToFilePath", () => {
  it("builds the core.md path under timeline/ for a time-bearing id", () => {
    expect(sliceIdToFilePath("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline/core.md"
    );
  });

  it("builds the core.md path for a date-only id", () => {
    expect(sliceIdToFilePath("2026-07-10")).toBe(
      "memory/episodic/slices/2026/07/10/timeline/core.md"
    );
  });
});

// ─── New directory-based path functions ────────────────────────────────

describe("sliceIdToTimelineDir", () => {
  it("builds the timeline directory path", () => {
    expect(sliceIdToTimelineDir("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline"
    );
  });
});

describe("sliceIdToAgentPath", () => {
  it("builds the agent.md path", () => {
    expect(sliceIdToAgentPath("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline/agent.md"
    );
  });
});

// ─── Backward-compatible parsing ───────────────────────────────────────

describe("parseSlice — backward compatibility", () => {
  it("parses legacy turn headers (numeric index, no turnId)", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Old format message

## Turn 2 — 2024-01-01T00:01:00.000Z (agent)

Old format reply
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[0].turnId).toBeUndefined();
    expect(parsed.turns[1].role).toBe("agent");
    expect(parsed.turns[1].turnId).toBeUndefined();
    expect(parsed.turns[0].content).toBe("Old format message");
  });

  it("parses new-format turn headers (base64url turnId)", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn a3fk2w — 2024-01-01T00:00:00.000Z (user)

New format message

## Turn b4gl3x — 2024-01-01T00:01:00.000Z (agent)

New format reply
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].turnId).toBe("a3fk2w");
    expect(parsed.turns[1].turnId).toBe("b4gl3x");
  });

  it("handles mixed old and new format turn headers", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Legacy turn

## Turn x7_y9z — 2024-01-01T00:01:00.000Z (agent)

New turn
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].turnId).toBeUndefined();  // legacy numeric
    expect(parsed.turns[1].turnId).toBe("x7_y9z");   // new base64url
  });
});

// ─── previously.md path ─────────────────────────────────────────────────

describe("sliceIdToPreviouslyPath", () => {
  it("builds the previously.md path at slice root (sibling to timeline/)", () => {
    expect(sliceIdToPreviouslyPath("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/previously.md",
    );
  });

  it("builds the previously.md path for a date-only id", () => {
    expect(sliceIdToPreviouslyPath("2026-07-10")).toBe(
      "memory/episodic/slices/2026/07/10/previously.md",
    );
  });
});

// ─── emptyPreviouslyTemplate ────────────────────────────────────────────

describe("emptyPreviouslyTemplate", () => {
  it("is a user-card (v4) template with the active slice header", () => {
    const tmpl = emptyPreviouslyTemplate("2026-07-24-1445");
    expect(tmpl).toContain("# Previously On");
    expect(tmpl).toContain("_Active slice: 2026-07-24-1445");
    expect(tmpl).toContain("Format: user card");
  });
});

// ─── readPreviously / ensurePreviously (v3 migration on read) ────────────

const LEGACY_V2_PREVIOUSLY = `# Previously On

_Active slice: 2026-07-26-1539 | Updated: 2026-07-26T15:41:34.834Z_

## 长期记忆

### User identity

- 用户名叫 LikeDreamwalker
  evidence: [2026/07/26/1539-esXr7w] | confidence: medium | updated: 2026-07-26 | obs: 1

## 短期记忆
`;

describe("readPreviously (v3 migration on read)", () => {
  beforeEach(() => {
    vi.mocked(fsReadFile).mockReset();
    vi.mocked(fsWriteFile).mockReset();
    vi.mocked(fsListFiles).mockReset();
  });

  it("migrates legacy v2 content to the v3 structure so the model never sees v2", async () => {
    vi.mocked(fsReadFile).mockResolvedValue(LEGACY_V2_PREVIOUSLY);
    const content = await readPreviously("2026-07-26-1539");
    expect(content).toContain("## User profile");
    expect(content).toContain("## Self-model");
    expect(content).not.toContain("## 长期记忆");
    expect(content).not.toContain("## 短期记忆");
    expect(content).toContain("用户名叫 LikeDreamwalker");
  });

  it("returns an empty string when the file does not exist", async () => {
    vi.mocked(fsReadFile).mockRejectedValue(new Error("ENOENT"));
    await expect(readPreviously("2026-07-26-1539")).resolves.toBe("");
  });

  it("persists the migration once when ensurePreviously finds a legacy file", async () => {
    vi.mocked(fsReadFile).mockResolvedValue(LEGACY_V2_PREVIOUSLY);
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    const content = await ensurePreviously("2026-07-26-1539");
    // Legacy v2 folds into the user-card structure (v4), keeping the identity fact.
    expect(content).toContain("Format: user card");
    expect(content).toContain("用户名叫 LikeDreamwalker");
    // live card migration + the fresh per-slice copy.
    expect(fsWriteFile).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite already-v3 content in ensurePreviously", async () => {
    const v3 = emptyPreviouslyTemplate("2026-07-26-1539");
    vi.mocked(fsReadFile).mockResolvedValue(v3);
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    await ensurePreviously("2026-07-26-1539");
    expect(fsWriteFile).not.toHaveBeenCalled();
  });
});


// ─── Live current card (v0.7 real-time) ────────────────────────────────

describe("live current card (current-previously.md)", () => {
  const CARD_A = emptyPreviouslyTemplate("2026-08-09-1000");
  const CARD_B = emptyPreviouslyTemplate("2026-08-09-1100");

  beforeEach(() => {
    vi.mocked(fsReadFile).mockReset();
    vi.mocked(fsWriteFile).mockReset();
    vi.mocked(fsListFiles).mockReset();
  });

  it("returns the LIVE card and copies it to the per-slice file when they differ", async () => {
    vi.mocked(fsReadFile)
      .mockResolvedValueOnce(CARD_B) // readCurrentPreviously → live card
      .mockResolvedValueOnce(CARD_A); // readPreviouslyRaw(slice) → old copy
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    const content = await ensurePreviously("2026-08-09-1000");
    expect(content).toBe(CARD_B);
    // The stale per-slice copy is overwritten with the fresh live card.
    expect(fsWriteFile).toHaveBeenCalledTimes(1);
  });

  it("seeds the live card from a template when it does not exist", async () => {
    vi.mocked(fsReadFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    const content = await ensurePreviously("2026-08-09-1000");
    expect(content).toContain("Format: user card");
    // live card + per-slice copy (slice has none yet).
    expect(fsWriteFile).toHaveBeenCalledTimes(2);
  });

  it("round-trips readCurrentPreviously / writeCurrentPreviously", async () => {
    vi.mocked(fsReadFile).mockResolvedValue(CARD_A);
    await writeCurrentPreviously(CARD_A);
    expect(await readCurrentPreviously()).toBe(CARD_A);
  });
});

// ─── closedBy round-trip (v0.8) ──────────────────────────────────────────

describe("closedBy round-trip", () => {
  it("persists the real close signal in frontmatter and parses it back", () => {
    const closed = { ...sampleSlice, closedBy: "time_silence" as const };
    const md = serializeSlice(closed);
    expect(md).toContain("closed_by: time_silence");
    expect(parseSlice(md).closedBy).toBe("time_silence");
  });

  it("falls back to user_explicit for legacy closed slices without closed_by", () => {
    const md = serializeSlice({ ...sampleSlice, closedBy: undefined });
    expect(md).not.toContain("closed_by");
    expect(parseSlice(md).closedBy).toBe("user_explicit");
  });

  it("falls back to user_explicit for an unknown closed_by value", () => {
    const md = serializeSlice({
      ...sampleSlice,
      closedBy: "capacity" as const,
    }).replace("closed_by: capacity", "closed_by: bogus_signal");
    expect(parseSlice(md).closedBy).toBe("user_explicit");
  });

  it("leaves closedBy undefined on active slices", () => {
    const parsed = parseSlice(
      serializeSlice({
        ...sampleSlice,
        status: "active" as const,
        closedBy: undefined,
      }),
    );
    expect(parsed.closedBy).toBeUndefined();
  });
});

// ─── evolutionSummary round-trip (v0.9 slice-level prompt freeze) ─────────

describe("evolutionSummary round-trip", () => {
  it("persists the birth-evolution summary in frontmatter and parses it back", () => {
    const slice = {
      ...sampleSlice,
      evolutionSummary: "sharpened the profile around work stress",
    };
    const md = serializeSlice(slice);
    expect(md).toContain(
      "evolution_summary: sharpened the profile around work stress",
    );
    expect(parseSlice(md).evolutionSummary).toBe(
      "sharpened the profile around work stress",
    );
  });

  it("omits the field when no evolution ran and reads back undefined", () => {
    const md = serializeSlice({ ...sampleSlice, evolutionSummary: undefined });
    expect(md).not.toContain("evolution_summary");
    expect(parseSlice(md).evolutionSummary).toBeUndefined();
  });
});

// ─── KNOWN LIMITATION pin: turn-header collision ─────────────────────────
//
// parseTurns' header regex (/^## Turn (\S+) — (\S+) \((\w+)\)$/gm) matches ANY
// line shaped like a turn header — including one embedded in a message body
// (e.g. the user pastes a slice excerpt). Such a line splits one real turn
// into two parsed turns. This test PINS the current (wrong) behavior so a
// future fix deliberately flips it.

describe("parseSlice — turn-header collision (KNOWN LIMITATION pin)", () => {
  it("a body line shaped like a turn header currently splits the parse", () => {
    const md = serializeSlice({
      ...sampleSlice,
      turns: [
        {
          timestamp: "2024-03-15T10:00:00.000Z",
          role: "user" as const,
          content:
            "look at this line:\n## Turn abc — 2026-01-01T00:00:00Z (user)\nisn't it odd",
          turnId: "a3fk2w",
        },
      ],
    });
    const parsed = parseSlice(md);
    // 1 real user turn + 1 phantom turn parsed out of the message body.
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[1].turnId).toBe("abc");
    expect(parsed.turns[1].timestamp).toBe("2026-01-01T00:00:00Z");
    expect(parsed.turns[1].content).toBe("isn't it odd");
  });
});

// ─── closeSlice end semantics + cross-UTC-day recovery ───────────────────

describe("closeSlice — end is the conversation's last turn, not the close time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "x", created: true });
    vi.mocked(fsReadFile).mockRejectedValue(new Error("not found"));
  });

  it("stamps end with the last turn's timestamp (lazy close may run hours later)", async () => {
    const slice: TimeSlice = {
      ...sampleSlice,
      status: "active",
      end: undefined,
      tags: [],
      turns: sampleTurns,
    };
    const closed = await closeSlice(slice, "time_silence");
    expect(closed.end).toBe("2024-03-15T10:02:00.000Z");
  });

  it("falls back to now for a turn-less slice", async () => {
    const slice: TimeSlice = {
      ...sampleSlice,
      status: "active",
      end: undefined,
      tags: [],
      turns: [],
    };
    const closed = await closeSlice(slice, "capacity");
    expect(closed.end).toBeDefined();
    expect(Number.isNaN(Date.parse(closed.end!))).toBe(false);
  });
});

describe("tryLoadTodaySlice — UTC-day-boundary fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recovers a still-active slice from YESTERDAY's UTC directory", async () => {
    const now = new Date();
    const y = new Date(now.getTime() - 86_400_000);
    const dirOf = (d: Date) =>
      `memory/episodic/slices/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    const todayDir = dirOf(now);
    const yesterdayDir = dirOf(y);

    vi.mocked(fsListFiles).mockImplementation(async (dir: string) => {
      if (dir === todayDir) return [];
      if (dir === yesterdayDir)
        return [{ name: "2330", path: `${yesterdayDir}/2330`, type: "dir" as const }];
      return [];
    });
    vi.mocked(fsReadFile).mockResolvedValue(
      serializeSlice({ ...sampleSlice, status: "active", end: undefined }),
    );

    const recovered = await tryLoadTodaySlice();
    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe("active");
    // Today's directory was scanned first (empty), then yesterday's.
    expect(vi.mocked(fsListFiles).mock.calls.map((c) => c[0])).toEqual([
      todayDir,
      yesterdayDir,
    ]);
  });

  it("returns null when neither today nor yesterday holds an active slice", async () => {
    vi.mocked(fsListFiles).mockResolvedValue([]);
    expect(await tryLoadTodaySlice()).toBeNull();
  });
});
