import { describe, it, expect } from "vitest";
import {
  buildStream,
  deriveAgentStage,
  progressStageTone,
  type AnyPart,
} from "@/lib/chat/build-stream";

// buildStream is the pure part→item classifier that drives the chat streaming
// UI. It was extracted from chat-message.tsx precisely so these decision rules
// (part ordering, housekeeping merging, tool-progress routing, terminal phases)
// could be pinned without a DOM.

function part(p: AnyPart): AnyPart {
  return p;
}

/** Two compact data-phase chunks — running=true then running=false — for a phase. */
function phaseChunks(phase: string, running: boolean): AnyPart {
  return {
    type: "data-phase",
    data: { phase, running, compact: true },
  };
}

describe("buildStream — housekeeping grouping", () => {
  it("merges consecutive compact phases into ONE housekeeping card with steps", () => {
    const parts = [
      phaseChunks("slice", true),
      phaseChunks("tags", true),
      phaseChunks("slice", false),
      phaseChunks("tags", false),
      phaseChunks("context", true),
      phaseChunks("context", false),
      phaseChunks("strands", true),
      phaseChunks("strands", false),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "housekeeping" });
    const steps = (items[0] as { kind: "housekeeping"; steps: unknown[] }).steps;
    expect(steps.map((s) => (s as { phase: string }).phase)).toEqual([
      "slice",
      "tags",
      "context",
      "strands",
    ]);
    expect(
      steps.every((s) => (s as { running: boolean }).running === false),
    ).toBe(true);
  });

  it("keeps a step running until its done chunk arrives", () => {
    const parts = [
      phaseChunks("slice", true),
      phaseChunks("tags", true),
      phaseChunks("tags", false),
    ];
    const items = buildStream(parts, false);
    const steps = (items[0] as { kind: "housekeeping"; steps: { phase: string; running: boolean }[] }).steps;
    expect(steps.find((s) => s.phase === "slice")!.running).toBe(true);
    expect(steps.find((s) => s.phase === "tags")!.running).toBe(false);
  });

  it("merges a closed-slice phase into the same card", () => {
    const parts = [
      phaseChunks("slice", true),
      phaseChunks("slice-closed", false),
      phaseChunks("slice", false),
    ];
    const items = buildStream(parts, false);
    const steps = (items[0] as { kind: "housekeeping"; steps: { phase: string }[] }).steps;
    expect(steps.map((s) => s.phase)).toEqual(["slice", "slice-closed"]);
  });
});

describe("buildStream — data-evolution as a standalone stream item", () => {
  function evolutionChunk(data: Record<string, unknown>): AnyPart {
    return { type: "data-evolution", data };
  }

  it("becomes its own item at the natural stream position (between context and strands)", () => {
    const parts = [
      phaseChunks("slice", true),
      phaseChunks("slice", false),
      phaseChunks("context", true),
      evolutionChunk({ status: "running", step: "reading" }),
      evolutionChunk({ status: "done", hasChanges: false, note: "nothing worth sedimenting" }),
      phaseChunks("context", false),
      phaseChunks("strands", true),
      phaseChunks("strands", false),
    ];
    const items = buildStream(parts, false);
    expect(items.map((i) => i.kind)).toEqual(["housekeeping", "evolution"]);
    // The housekeeping card no longer carries an evolution sub-step.
    const hk = items[0] as { kind: "housekeeping"; steps: { phase: string }[] };
    expect(hk.steps.map((s) => s.phase)).toEqual(["slice", "context", "strands"]);
    // The terminal chunk wins: settled, with the full state retained.
    const evo = items[1] as {
      kind: "evolution";
      running: boolean;
      data: Record<string, unknown>;
    };
    expect(evo.running).toBe(false);
    expect(evo.data).toMatchObject({
      status: "done",
      hasChanges: false,
      note: "nothing worth sedimenting",
    });
  });

  it("keeps the item running with its step + live thinking line while mid-run", () => {
    const parts = [
      phaseChunks("context", true),
      evolutionChunk({
        status: "running",
        step: "reviewing",
        live: "这条偏好上周强化过一次…",
        liveStage: "thinking",
      }),
    ];
    const items = buildStream(parts, false);
    const evo = items.find((i) => i.kind === "evolution") as {
      running: boolean;
      data: Record<string, unknown>;
    };
    expect(evo.running).toBe(true);
    expect(evo.data).toMatchObject({
      step: "reviewing",
      live: "这条偏好上周强化过一次…",
      liveStage: "thinking",
    });
  });

  it("retains summary / mutations / error / partial for the card's terminal rendering", () => {
    const parts = [
      evolutionChunk({
        status: "done",
        hasChanges: true,
        partial: true,
        changes: { added: 1, reinforced: 0, demoted: 0, removed: 1, superseded: 0 },
        summary: "Noted the time-first preference",
        note: "The kickoff-prep item expired.",
        mutations: [
          { type: "added", text: "Now: shipping v0.9" },
          { type: "removed", text: "Now: kickoff prep" },
        ],
      }),
      evolutionChunk({ status: "done", error: "worker timeout" }),
    ];
    const items = buildStream(parts, false);
    // A lone evolution chunk creates the item even without any phase chunks.
    expect(items).toHaveLength(1);
    const evo = items[0] as {
      kind: "evolution";
      running: boolean;
      data: Record<string, unknown>;
    };
    // The LAST chunk's state wins (progress part and result part arrive in
    // stream order; the terminal result carries the error here).
    expect(evo.running).toBe(false);
    expect(evo.data).toMatchObject({
      status: "done",
      error: "worker timeout",
    });
  });

  it("keeps legacy chunks (no status field) working via the old running flag", () => {
    const parts = [
      phaseChunks("context", true),
      evolutionChunk({ running: true, step: "reading" }),
      evolutionChunk({ running: false, hasChanges: false, note: "checked" }),
    ];
    const items = buildStream(parts, false);
    const evo = items.find((i) => i.kind === "evolution") as {
      running: boolean;
      data: Record<string, unknown>;
    };
    // Terminal legacy chunk: running=false maps to settled.
    expect(evo.running).toBe(false);
    expect(evo.data).toMatchObject({ running: false, hasChanges: false });

    // A legacy mid-run chunk still reads as running.
    const midRun = buildStream(
      [evolutionChunk({ running: true, step: "reading" })],
      false,
    );
    expect((midRun[0] as { running: boolean }).running).toBe(true);
  });
});

describe("buildStream — part classification order", () => {
  it("keeps reasoning, tool, and text in natural stream order", () => {
    const parts = [
      part({ type: "reasoning", text: "Let me check" }),
      part({ type: "tool-input-streaming", toolCallId: "t1", toolName: "recall", state: "input-streaming" }),
      part({ type: "tool-output-available", toolCallId: "t1", toolName: "recall", state: "output-available", output: { hits: [] } }),
      part({ type: "text", text: "Here is the answer." }),
    ];
    const items = buildStream(parts, false);
    expect(items.map((i) => i.kind)).toEqual(["reasoning", "tool", "text"]);
  });

  it("merges consecutive reasoning deltas into one block", () => {
    const parts = [
      part({ type: "reasoning", text: "The" }),
      part({ type: "reasoning", text: " plan" }),
      part({ type: "text", text: "answer" }),
    ];
    const items = buildStream(parts, false);
    expect(items[0]).toMatchObject({ kind: "reasoning", text: "The plan" });
  });

  it("merges tool parts sharing a toolCallId into one card", () => {
    const parts = [
      part({ type: "tool-input-streaming", toolCallId: "t1", toolName: "recall", state: "input-streaming", input: { query: "x" } }),
      part({ type: "tool-output-available", toolCallId: "t1", toolName: "recall", state: "output-available", output: { hits: [] } }),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", toolCallId: "t1", state: "output-available" });
  });
});

describe("buildStream — tool progress routing", () => {
  it("buffers a progress chunk that arrives before its tool part", () => {
    const parts = [
      part({ type: "data-tool-progress", data: { toolCallId: "t1", toolName: "recall", text: "Scanning memory…", stage: "running" } }),
      part({ type: "tool-input-available", toolCallId: "t1", toolName: "recall", state: "input-available" }),
    ];
    const items = buildStream(parts, false);
    expect(items[0]).toMatchObject({ kind: "tool", streamingText: "Scanning memory…" });
  });

  it("updates an existing tool item's streaming text and stage", () => {
    const parts = [
      part({ type: "tool-input-available", toolCallId: "t1", toolName: "recall", state: "input-available" }),
      part({ type: "data-tool-progress", data: { toolCallId: "t1", toolName: "recall", text: "Found 3 matches", stage: "done" } }),
    ];
    const items = buildStream(parts, false);
    expect(items[0]).toMatchObject({ kind: "tool", streamingText: "Found 3 matches", streamingStage: "done" });
  });
});

describe("buildStream — terminal turn status", () => {
  it("creates a terminal error phase with the client-visible explanation", () => {
    const parts = [
      part({ type: "data-turn-status", data: { status: "error", error: "Model call failed" } }),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "phase", phase: "terminal-error", mode: "terminal", summaries: ["Model call failed"] });
  });

  it("creates a terminal interrupted phase", () => {
    const parts = [part({ type: "data-turn-status", data: { status: "interrupted" } })];
    const items = buildStream(parts, false);
    expect(items[0]).toMatchObject({ kind: "phase", phase: "terminal-interrupted", mode: "terminal" });
  });

  it("skips active and done statuses entirely", () => {
    const parts = [
      part({ type: "data-turn-status", data: { status: "active" } }),
      part({ type: "data-turn-status", data: { status: "done" } }),
    ];
    expect(buildStream(parts, false)).toHaveLength(0);
  });
});

describe("deriveAgentStage", () => {
  it("returns null during housekeeping (no significant activity yet)", () => {
    expect(deriveAgentStage([phaseChunks("slice", true)])).toBeNull();
    expect(deriveAgentStage([])).toBeNull();
  });

  it("reads memory tools as recalling", () => {
    const parts = [
      part({ type: "tool-input-available", toolCallId: "t1", toolName: "readSlice", state: "input-available" }),
    ];
    expect(deriveAgentStage(parts)).toBe("recalling");
    expect(
      deriveAgentStage([part({ type: "data-tool-progress", data: { toolCallId: "t1", toolName: "recall", text: "x" } })]),
    ).toBe("recalling");
  });

  it("reads other tools as working", () => {
    expect(
      deriveAgentStage([part({ type: "tool-input-available", toolCallId: "t1", toolName: "webSearch", state: "input-available" })]),
    ).toBe("working");
  });

  it("reads reasoning and text as reasoning / composing", () => {
    expect(deriveAgentStage([part({ type: "reasoning", text: "x" })])).toBe("reasoning");
    expect(deriveAgentStage([part({ type: "text", text: "x" })])).toBe("composing");
  });

  it("the last significant part wins", () => {
    const parts = [
      part({ type: "tool-input-available", toolCallId: "t1", toolName: "recall", state: "input-available" }),
      part({ type: "reasoning", text: "x" }),
      part({ type: "text", text: "answer" }),
    ];
    expect(deriveAgentStage(parts)).toBe("composing");
  });
});

describe("progressStageTone", () => {
  it("maps settled stages (writing/done) to the answer tone", () => {
    expect(progressStageTone("writing")).toBe("answer");
    expect(progressStageTone("done")).toBe("answer");
  });

  it("maps in-progress stages to the thinking tone", () => {
    expect(progressStageTone("running")).toBe("thinking");
    expect(progressStageTone("thinking")).toBe("thinking");
    // legacy "reasoning" (pre-4-state) still reads as thinking
    expect(progressStageTone("reasoning")).toBe("thinking");
    expect(progressStageTone(undefined)).toBe("thinking");
  });
});
