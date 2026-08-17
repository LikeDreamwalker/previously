/**
 * Tests for the turn-merge self-heal (B2) — re-parse the remote slice,
 * append missing turns by turnId, union tags/loops, re-serialize.
 */
import { describe, it, expect } from "vitest";
import { mergeTurnsWithRemote } from "@/lib/episodic/turn-merge";
import { serializeSlice, parseSlice } from "@/lib/episodic/manager";
import type { TimeSlice, Turn } from "@/lib/episodic/types";

function makeTurn(turnId: string, content: string, role: "user" | "agent" = "user"): Turn {
  return {
    timestamp: "2026-08-16T10:00:00.000Z",
    role,
    content,
    turnId,
  };
}

function makeSlice(overrides: Partial<TimeSlice>): TimeSlice {
  return {
    slice_id: "2026-08-16-1000",
    focus: "API design",
    status: "active",
    start: "2026-08-16T09:55:00.000Z",
    timezone: "UTC",
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    loops: [],
    turns: [],
    estimatedTokens: 0,
    ...overrides,
  };
}

describe("mergeTurnsWithRemote", () => {
  it("appends local turns the remote is missing (keyed by turnId)", () => {
    const shared = makeTurn("t1", "hello");
    const remoteTurn = makeTurn("t2", "remote answer", "agent");
    const remote = serializeSlice(
      makeSlice({ turns: [shared, remoteTurn] }),
    );
    const local = makeSlice({
      turns: [shared, makeTurn("t3", "follow-up")],
    });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));

    expect(merged.turns.map((t) => t.turnId)).toEqual(["t1", "t2", "t3"]);
    // No duplication of the shared turn.
    expect(merged.turns.filter((t) => t.turnId === "t1")).toHaveLength(1);
  });

  it("is a no-op when the remote already has every turn", () => {
    const turns = [makeTurn("t1", "a"), makeTurn("t2", "b", "agent")];
    const remote = serializeSlice(makeSlice({ turns }));
    const local = makeSlice({ turns: [...turns] });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.turns).toHaveLength(2);
  });

  it("unions tags and loop pointers without duplicates", () => {
    const remote = serializeSlice(makeSlice({ tags: ["api"], loops: ["loop-1"] }));
    const local = makeSlice({
      turns: [makeTurn("t1", "x")],
      tags: ["api", "design"],
      loops: ["loop-1", "loop-2"],
    });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.tags).toEqual(["api", "design"]);
    expect(merged.loops).toEqual(["loop-1", "loop-2"]);
  });

  it("keeps the REMOTE frontmatter (close marking etc. wins over our stale copy)", () => {
    const remote = serializeSlice(
      makeSlice({ focus: "updated remotely", status: "closed", turns: [] }),
    );
    const local = makeSlice({ focus: "stale focus", turns: [makeTurn("t1", "x")] });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.focus).toBe("updated remotely");
    expect(merged.status).toBe("closed");
  });

  it("dedupes legacy turns without turnId by content fingerprint", () => {
    // A genuinely legacy (numeric-label) remote body — parseSlice gives the
    // turn no turnId, so the merge falls back to the content fingerprint.
    const remote = [
      "---",
      "slice_id: 2026-08-16-1000",
      "status: active",
      "---",
      "",
      "## Turn 1 — 2026-08-16T09:00:00.000Z (user)",
      "",
      "legacy turn body",
    ].join("\n");
    const local = makeSlice({
      turns: [
        {
          timestamp: "2026-08-16T09:00:00.000Z",
          role: "user",
          content: "legacy turn body",
        },
      ],
    });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.turns).toHaveLength(1);
  });
});
