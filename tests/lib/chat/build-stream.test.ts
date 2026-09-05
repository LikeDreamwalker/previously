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

  it("passes the v1.0 calibration fields (triggers / direction / playbooks) through on the terminal chunk", () => {
    const parts = [
      evolutionChunk({ status: "running", step: "reviewing" }),
      evolutionChunk({
        status: "done",
        hasChanges: false,
        note: "reviewed",
        triggers: [{ bucket: "recall", score: -4 }],
        direction: { outcome: "updated", summary: "direction v1" },
        playbooks: [{ agent: "recall", summary: "fewer unverified answers" }],
      }),
    ];
    const items = buildStream(parts, false);
    const evo = items[0] as {
      kind: "evolution";
      running: boolean;
      data: Record<string, unknown>;
    };
    expect(evo.running).toBe(false);
    expect(evo.data).toMatchObject({
      status: "done",
      triggers: [{ bucket: "recall", score: -4 }],
      direction: { outcome: "updated", summary: "direction v1" },
      playbooks: [{ agent: "recall", summary: "fewer unverified answers" }],
    });
  });

  it("leaves the calibration fields absent on legacy / analyzer-gated terminal chunks", () => {
    const parts = [
      evolutionChunk({ status: "done", hasChanges: false, note: "checked" }),
    ];
    const items = buildStream(parts, false);
    const evo = items[0] as { data: Record<string, unknown> };
    expect(evo.data.triggers).toBeUndefined();
    expect(evo.data.direction).toBeUndefined();
    expect(evo.data.playbooks).toBeUndefined();
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

describe("buildStream — bridge tool activity (data-phase with tools)", () => {
  const toolRows = [
    { name: "Read", summary: "Read memory/a.md", status: "ok" },
    { name: "Bash", summary: "Bash pnpm test", status: "start" },
  ];

  it("becomes a bridge-tools item (merged by phase, last chunk wins)", () => {
    const parts = [
      part({
        type: "data-phase",
        data: { phase: "stageWorking", running: true, summaries: ["Read memory/a.md"], tools: [toolRows[0]] },
      }),
      part({
        type: "data-phase",
        data: { phase: "stageWorking", running: false, summaries: ["Read memory/a.md", "Bash pnpm test"], tools: toolRows },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "bridge-tools",
      phase: "stageWorking",
      running: false,
      tools: toolRows,
    });
  });

  it("keeps housekeeping and chat bridge activity as separate items (distinct phases)", () => {
    const parts = [
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: false, summaries: [], tools: [toolRows[0]] },
      }),
      phaseChunks("strands", true),
      part({
        type: "data-phase",
        data: { phase: "stageWorking", running: true, summaries: [], tools: toolRows },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items.map((i) => i.kind)).toEqual([
      "bridge-tools",
      "housekeeping",
      "bridge-tools",
    ]);
    expect((items[0] as { phase: string }).phase).toBe("bridgeHousekeeping");
    expect((items[2] as { phase: string }).phase).toBe("stageWorking");
  });

  it("keeps the legacy tools-less data-phase rendering as a plain phase item", () => {
    const parts = [
      part({
        type: "data-phase",
        data: { phase: "stageWorking", running: true, summaries: ["Read x"] },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items[0]).toMatchObject({ kind: "phase", phase: "stageWorking" });
  });

  it("carries the rolling narration line (live), last frame wins", () => {
    const parts = [
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: true, summaries: [], tools: [], live: "Reading the slice" },
      }),
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: true, summaries: [], tools: [], live: "Reading the slice…" },
      }),
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: false, summaries: [], tools: [], live: "Reading the slice…" },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "bridge-tools",
      phase: "bridgeHousekeeping",
      running: false,
      live: "Reading the slice…",
      tools: [],
    });
  });

  it("carries the client-mode wrap-up steps, last frame wins", () => {
    const parts = [
      part({
        type: "data-phase",
        data: {
          phase: "bridgeHousekeeping",
          running: true,
          summaries: [],
          tools: [],
          steps: [{ phase: "slice", running: true }],
        },
      }),
      part({
        type: "data-phase",
        data: {
          phase: "bridgeHousekeeping",
          running: true,
          summaries: [],
          tools: [toolRows[0]],
          live: "Analyzing the turn",
          steps: [
            { phase: "slice", running: true },
            { phase: "analyze", running: true },
          ],
        },
      }),
      part({
        type: "data-phase",
        data: {
          phase: "bridgeHousekeeping",
          running: false,
          summaries: [],
          tools: [toolRows[0]],
          steps: [
            { phase: "slice", running: false, summaries: ["2026-08-22-1015"] },
            { phase: "analyze", running: false, summaries: ["work"] },
          ],
        },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "bridge-tools",
      phase: "bridgeHousekeeping",
      running: false,
      tools: [toolRows[0]],
      steps: [
        { phase: "slice", running: false, summaries: ["2026-08-22-1015"] },
        { phase: "analyze", running: false, summaries: ["work"] },
      ],
    });
    // A frame without a steps field leaves the accumulated steps untouched.
    const parts2 = [
      ...parts,
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: false, summaries: [], tools: [toolRows[0]] },
      }),
    ];
    const items2 = buildStream(parts2, false);
    expect((items2[0] as { steps?: unknown[] }).steps).toHaveLength(2);
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

describe("buildStream — bridge authoritative re-emit (divergent deltas)", () => {
  it("replaces earlier text items instead of concatenating", () => {
    // The bridge model re-emits the envelope result marked authoritative when
    // the advisory deltas diverged — the UI must show ONLY the final text.
    const parts = [
      part({ type: "text", text: "draft" }),
      part({
        type: "text",
        text: "final answer",
        providerMetadata: { "previously-bridge": { authoritative: true } },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items).toEqual([{ kind: "text", content: "final answer" }]);
  });

  it("replaces text already flushed to items by an interleaved data-phase", () => {
    const parts = [
      part({ type: "text", text: "draft" }),
      part({
        type: "data-phase",
        data: { phase: "stageWorking", running: true, summaries: [], tools: [] },
      }),
      part({
        type: "text",
        text: "final answer",
        providerMetadata: { "previously-bridge": { authoritative: true } },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items.map((i) => i.kind)).toEqual(["bridge-tools", "text"]);
    expect(items[1]).toMatchObject({ kind: "text", content: "final answer" });
  });

  it("leaves unmarked consecutive text parts concatenated (normal mode unchanged)", () => {
    const parts = [
      part({ type: "text", text: "a" }),
      part({ type: "text", text: "b" }),
    ];
    const items = buildStream(parts, false);
    expect(items).toEqual([{ kind: "text", content: "ab" }]);
  });
});

describe("buildStream — bridge housekeeping degradation warning", () => {
  it("passes the warning through to the bridge-tools item (last frame wins)", () => {
    const parts = [
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: true, summaries: [], tools: [] },
      }),
      part({
        type: "data-phase",
        data: { phase: "bridgeHousekeeping", running: false, summaries: [], tools: [], warning: "timeout" },
      }),
    ];
    const items = buildStream(parts, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "bridge-tools",
      phase: "bridgeHousekeeping",
      running: false,
      warning: "timeout",
    });
  });
});

describe("deriveAgentStage — bridge data-phase", () => {
  it("reads the bridge chat activity phase as working, clearing when it settles", () => {
    expect(
      deriveAgentStage([
        part({ type: "data-phase", data: { phase: "stageWorking", running: true, tools: [] } }),
      ]),
    ).toBe("working");
    expect(
      deriveAgentStage([
        part({ type: "data-phase", data: { phase: "stageWorking", running: false, tools: [] } }),
      ]),
    ).toBeNull();
  });

  it("ignores the bridge housekeeping phase (the prep card is showing)", () => {
    expect(
      deriveAgentStage([
        part({ type: "data-phase", data: { phase: "bridgeHousekeeping", running: true, tools: [] } }),
      ]),
    ).toBeNull();
  });
});

describe("buildStream — recall references bar (v0.10 §4.1)", () => {
  const refsChunk = (
    references: Array<{ slice_id: string; note?: string } | null>,
  ): AnyPart =>
    part({
      type: "data-recall-references",
      data: { references },
    });

  it("collects the anchors into ONE trailing item under the reply", () => {
    const items = buildStream(
      [
        part({ type: "tool-recall", toolCallId: "tc1", state: "running" }),
        refsChunk([
          { slice_id: "2026-08-01-1000", note: "a" },
          { slice_id: "2026-08-02-1100", note: "b" },
        ]),
        part({ type: "text", text: "The answer." }),
      ],
      false,
    );
    const bar = items.find((i) => i.kind === "recall-references");
    expect(bar).toBeDefined();
    // Trailing: the bar sits AFTER the reply text, not mid-stream.
    expect(items[items.length - 1]).toBe(bar);
    expect(
      (bar as { references: Array<{ slice_id: string }> }).references.map(
        (r) => r.slice_id,
      ),
    ).toEqual(["2026-08-01-1000", "2026-08-02-1100"]);
  });

  it("merges several recall calls in one turn, deduped by slice id", () => {
    const items = buildStream(
      [
        refsChunk([{ slice_id: "2026-08-01-1000" }]),
        part({ type: "text", text: "half" }),
        refsChunk([
          { slice_id: "2026-08-01-1000", note: "dup" },
          { slice_id: "2026-08-03-1200" },
        ]),
      ],
      false,
    );
    const bars = items.filter((i) => i.kind === "recall-references");
    expect(bars).toHaveLength(1);
    expect(
      (bars[0] as { references: Array<{ slice_id: string }> }).references.map(
        (r) => r.slice_id,
      ),
    ).toEqual(["2026-08-01-1000", "2026-08-03-1200"]);
  });

  it("drops malformed anchors and emits no bar when nothing survives", () => {
    const items = buildStream(
      [
        part({
          type: "data-recall-references",
          data: { references: [{ slice_id: "" }, { note: "no id" }, null] },
        }),
        part({ type: "text", text: "answer" }),
      ],
      false,
    );
    expect(items.some((i) => i.kind === "recall-references")).toBe(false);
  });

  it("does not split the streaming text buffer", () => {
    const items = buildStream(
      [
        part({ type: "text", text: "before " }),
        refsChunk([{ slice_id: "2026-08-01-1000" }]),
        part({ type: "text", text: "after" }),
      ],
      false,
    );
    const texts = items.filter((i) => i.kind === "text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { content: string }).content).toBe("before after");
  });
});
