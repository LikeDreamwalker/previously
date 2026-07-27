import { describe, it, expect } from "vitest";
import {
  parseSlice,
  serializeSlice,
  toIndexEntry,
  sliceIdToRelPath,
  sliceIdToFilePath,
  sliceIdToTimelineDir,
  sliceIdToAgentPath,
  sliceIdToPreviouslyPath,
  applyPreviouslyDecay,
  emptyPreviouslyTemplate,
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
  it("contains all three sections with placeholder text", () => {
    const tmpl = emptyPreviouslyTemplate("2026-07-24-1445");
    expect(tmpl).toContain("# Agent Beliefs");
    expect(tmpl).toContain("_Active slice: 2026-07-24-1445");
    expect(tmpl).toContain("## User identity");
    expect(tmpl).toContain("## User patterns");
    expect(tmpl).toContain("## Agent strategies");
    expect(tmpl).toContain("_No beliefs yet._");
  });
});

// ─── applyPreviouslyDecay ───────────────────────────────────────────────

describe("applyPreviouslyDecay", () => {
  const newSliceId = "2026-07-24-1500";

  it("de-rates 高→中 when last_seen is older than 14 days", () => {
    // 15 days ago
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 15);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const staleDate = `${y}/${m}/${day}/1200`;

    const content = `# Agent Beliefs

_Active slice: 2026-07-09-1200 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 偏好简洁结构化的回答
  (置信度: 高 | 首次: 2026/07/01/0500-a3fk2w | 最近: ${staleDate}-T2 | 观察: 6)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).toContain("置信度: 中");
    expect(result).not.toContain("置信度: 高");
  });

  it("de-rates 中→低 when last_seen is older than 14 days", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 20);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const staleDate = `${y}/${m}/${day}/1200`;

    const content = `# Agent Beliefs

_Active slice: 2026-07-04-1200 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 偏好结构化的回答
  (置信度: 中 | 首次: 2026/06/01/0500-a3fk2w | 最近: ${staleDate}-T1 | 观察: 3)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).toContain("置信度: 低");
    expect(result).not.toContain("置信度: 中");
  });

  it("prunes belief when confidence is 低 AND observations ≤ 2", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 20);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const staleDate = `${y}/${m}/${day}/1200`;

    const content = `# Agent Beliefs

_Active slice: 2026-07-04-1200 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 一个弱信念会被清除
  (置信度: 低 | 首次: 2026/06/01/0500-a3fk2w | 最近: ${staleDate}-T1 | 观察: 1)
- 另一个保留的信念
  (置信度: 高 | 首次: 2026/07/01/0500-a3fk2w | 最近: 2026/07/23/1500-T2 | 观察: 8)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).not.toContain("一个弱信念会被清除");
    expect(result).not.toContain("观察: 1");
    expect(result).toContain("另一个保留的信念");
    expect(result).toContain("置信度: 高");
  });

  it("does NOT prune when 低 but observations > 2", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 20);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const staleDate = `${y}/${m}/${day}/1200`;

    const content = `# Agent Beliefs

_Active slice: 2026-07-04-1200 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 一个有较多观察的弱信念
  (置信度: 低 | 首次: 2026/06/01/0500-a3fk2w | 最近: ${staleDate}-T1 | 观察: 5)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    // Low but 5 observations — should survive
    expect(result).toContain("一个有较多观察的弱信念");
    expect(result).toContain("置信度: 低"); // already 低, can't de-rate further
  });

  it("does NOT modify User identity section (factual, user-stated)", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 30);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const staleDate = `${y}/${m}/${day}/1200`;

    const content = `# Agent Beliefs

_Active slice: 2026-06-24-1200 | Last updated: Turn a3fk2w_

## User identity (factual beliefs — user explicitly stated these)
- 自称 Alan Yuan，可用 Alan 称呼
  (来源: ${staleDate}-T1，用户原话)

## User patterns (pattern beliefs — agent observed these)
- 偏好简洁
  (置信度: 高 | 首次: ${staleDate}-T1 | 最近: ${staleDate}-T1 | 观察: 10)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    // Identity belief survives untouched
    expect(result).toContain("自称 Alan Yuan");
    expect(result).toContain(`(来源: ${staleDate}-T1，用户原话)`);
    // Pattern belief gets de-rated
    expect(result).toContain("置信度: 中");
  });

  it("does NOT modify Agent strategies section", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-09-1200 | Last updated: Turn a3fk2w_

## Agent strategies (derived from beliefs above)
- 给出选项而非单一答案，让用户选方向
  (来源: User patterns — 迭代式节奏 + 2026/07/23/1445-T2 用户确认)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).toContain("给出选项而非单一答案");
    expect(result).toContain("User patterns — 迭代式节奏");
  });

  it("leaves recent beliefs (less than 14 days) unchanged", () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 3); // only 3 days ago
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const recentDate = `${y}/${m}/${day}/1200`;

    const content = `# Agent Beliefs

_Active slice: 2026-07-21-1200 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 偏好简洁结构化的回答
  (置信度: 高 | 首次: 2026/07/14/1435-T2 | 最近: ${recentDate}-T2 | 观察: 6)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).toContain("置信度: 高");
  });

  it("updates the active slice header line", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-09-1200 | Last updated: Turn a3fk2w_

## User patterns (pattern beliefs — agent observed these)
- 偏好简洁
  (置信度: 高 | 首次: 2026/07/01/0500-a3fk2w | 最近: 2026/07/23/1500-T2 | 观察: 10)
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).toContain("_Active slice: 2026-07-24-1500");
    expect(result).toContain("Last updated: (initial)");
    expect(result).not.toContain("2026-07-09-1200");
  });

  it("handles empty content gracefully", () => {
    const result = applyPreviouslyDecay("", newSliceId);
    expect(result).toBe("");
  });

  it("handles content with no beliefs (just headers)", () => {
    const content = `# Agent Beliefs

_Active slice: 2026-07-09-1200 | Last updated: Turn a3fk2w_

## User identity (factual beliefs — user explicitly stated these)

_No beliefs yet._

## User patterns (pattern beliefs — agent observed these)

_No beliefs yet._

## Agent strategies (derived from beliefs above)

_No beliefs yet._
`;
    const result = applyPreviouslyDecay(content, newSliceId);
    expect(result).toContain("_Active slice: 2026-07-24-1500");
    expect(result).toContain("_No beliefs yet._");
    expect(result).toContain("## User identity");
    expect(result).toContain("## User patterns");
    expect(result).toContain("## Agent strategies");
  });
});

