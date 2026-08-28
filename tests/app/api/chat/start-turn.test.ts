import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UIMessage } from "ai";

// start-turn.ts is a route module — stub its workflow boundary so importing it
// for the pure helpers below stays hermetic.
const workflow = vi.hoisted(() => ({ start: vi.fn(async () => ({})) }));
vi.mock("workflow/api", () => ({ start: workflow.start }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: vi.fn() }));

// Config + catalog + environment seams for the pinning tests.
const loader = vi.hoisted(() => ({ loadUserConfig: vi.fn() }));
vi.mock("@/lib/config/loader", () => ({ loadUserConfig: loader.loadUserConfig }));
vi.mock("@/lib/models/catalog", () => ({
  resolveAvailableModels: vi.fn(async () => []),
}));
vi.mock("@/lib/capabilities", () => ({
  getRepoConfig: () => ({ owner: "local", repo: "local" }),
}));
const dataSource = vi.hoisted(() => ({ resolveDataSource: vi.fn(() => "local") }));
vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: dataSource.resolveDataSource,
}));
const demoLock = vi.hoisted(() => ({
  demoModelLock: vi.fn(
    (): { model: string; thinking: boolean; effort: "low" | "medium" | "high" } | null =>
      null,
  ),
}));
vi.mock("@/lib/demo/model-lock", () => ({
  demoModelLock: demoLock.demoModelLock,
}));

import {
  startTurn,
  summarizeModelContent,
  stripFileParts,
} from "@/app/api/chat/start-turn";

describe("summarizeModelContent", () => {
  it("passes string content through unchanged", () => {
    expect(summarizeModelContent("hello")).toBe("hello");
  });

  it("keeps text parts as text", () => {
    expect(
      summarizeModelContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("replaces image file parts with [image] — never the base64 payload", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(100000)}`;
    const out = summarizeModelContent([
      { type: "text", text: "what is this?" },
      { type: "file", mediaType: "image/png", url: dataUrl },
    ]);
    expect(out).toBe("what is this?\n[image]");
    expect(out).not.toContain("base64");
  });

  it("replaces non-image file parts with [file]", () => {
    expect(
      summarizeModelContent([
        { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,xx" },
      ]),
    ).toBe("[file]");
  });

  it("collapses other parts to a [type] placeholder", () => {
    expect(
      summarizeModelContent([
        { type: "tool-call", toolName: "recall" },
        { type: "reasoning", text: "hmm" },
      ]),
    ).toBe("[tool-call]\n[reasoning]");
  });
});

describe("stripFileParts", () => {
  const msg = (parts: UIMessage["parts"], id: string): UIMessage =>
    ({ id, role: "user", parts }) as UIMessage;

  it("drops file parts and keeps text parts", () => {
    const out = stripFileParts([
      msg(
        [
          { type: "text", text: "hi" },
          { type: "file", mediaType: "image/png", url: "data:image/png;base64,xx" },
        ] as UIMessage["parts"],
        "m1",
      ),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("drops messages left with no parts at all", () => {
    const out = stripFileParts([
      msg(
        [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,xx" }] as UIMessage["parts"],
        "m1",
      ),
      msg([{ type: "text", text: "still here" }] as UIMessage["parts"], "m2"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("m2");
  });
});

// ─── startTurn: server-side thinking/effort pinning ─────────────────────────
// Product rule: fast responses — thinking is always ON at LOW effort for the
// main model, regardless of the request body or the stored config. Deep
// thinking is thinkDeep's job. Only the demo lock overrides the pin.

describe("startTurn thinking/effort pinning", () => {
  const SAVED_ENV = { ...process.env };

  const messages: UIMessage[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage,
  ];

  /** The TurnInput handed to the workflow run. */
  function turnInput(): Record<string, unknown> {
    const call = workflow.start.mock.calls.at(-1);
    expect(call).toBeDefined();
    const args = call as unknown as [unknown, [Record<string, unknown>]];
    return args[1][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED_ENV };
    dataSource.resolveDataSource.mockReturnValue("local");
    demoLock.demoModelLock.mockReturnValue(null);
    // A stored config that DISAGREES with the pin — must be ignored.
    loader.loadUserConfig.mockResolvedValue({
      model: {
        provider: "deepseek-v4-flash",
        thinking: false,
        reasoningEffort: "high",
      },
    });
  });

  it("pins thinking ON and effort LOW, ignoring body + config", async () => {
    await startTurn({
      messages,
      model: "deepseek-v4-flash",
      thinking: false, // client tries to disable — ignored
      effort: "high", // client tries to crank — ignored
    });
    const input = turnInput();
    expect(input.model).toBe("deepseek-v4-flash");
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("low");
  });

  it("pins effort LOW even when the stored config says high", async () => {
    await startTurn({ messages, model: "deepseek-v4-pro" });
    const input = turnInput();
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("low");
  });

  it("keeps thinking OFF for models without the capability (bridge)", async () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    await startTurn({ messages, model: "bridge/claude", thinking: true });
    const input = turnInput();
    expect(input.model).toBe("bridge/claude");
    expect(input.thinking).toBe(false);
    expect(input.reasoningEffort).toBe("low");
  });

  it("demo lock wins over the pin when active", async () => {
    demoLock.demoModelLock.mockReturnValue({
      model: "deepseek-v4-flash-vision-exp",
      thinking: true,
      effort: "medium",
    });
    await startTurn({
      messages,
      model: "claude-opus-4-8", // client choice — ignored under the lock
      effort: "high",
    });
    const input = turnInput();
    expect(input.model).toBe("deepseek-v4-flash-vision-exp");
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("medium");
  });
});
