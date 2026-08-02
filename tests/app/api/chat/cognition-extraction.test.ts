import { describe, it, expect } from "vitest";
import { extractCognition } from "@/app/api/chat/turn-workflow";
import type { ModelMessage } from "ai";

// ─── Types ──────────────────────────────────────────────────────────────

interface StepPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

interface CogStep {
  reasoning?: Array<{ type: string; text: string }>;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function msg(role: "tool", content: Array<Record<string, unknown>>): ModelMessage {
  return { role, content } as ModelMessage;
}

function step(opts: {
  reasoning?: string[];
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
}): CogStep {
  return {
    reasoning: opts.reasoning?.map((text) => ({ type: "reasoning", text })),
    toolCalls: opts.toolCalls,
  };
}

// ─── extractCognition ──────────────────────────────────────────────────

describe("extractCognition", () => {
  it("returns only a newline when there are no steps", () => {
    const result = extractCognition([], []);
    expect(result).toBe("\n");
  });

  it("extracts reasoning traces from steps under a Thinking section", () => {
    const steps: CogStep[] = [
      step({
        reasoning: [
          "The user is asking about Rust runtimes.",
          "I need to check their preferences first.",
        ],
      }),
    ];
    const result = extractCognition([], steps);
    expect(result).toContain("### Thinking");
    expect(result).toContain("The user is asking about Rust runtimes.");
    expect(result).toContain("I need to check their preferences first.");
    expect(result).not.toContain("### Tools");
  });

  it("extracts tool calls from steps with result status from messages", () => {
    const steps: CogStep[] = [
      step({
        toolCalls: [
          {
            toolCallId: "tc1",
            toolName: "readMemory",
            input: { path: "memory/nodes/rust-prefs.md" },
          },
        ],
      }),
    ];
    const messages: ModelMessage[] = [
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "readMemory",
          output: "...very long file content here...",
          isError: false,
        },
      ]),
    ];
    const result = extractCognition(messages, steps);
    expect(result).toContain("### Tools");
    expect(result).toContain("`readMemory`");
    expect(result).toContain('path: "memory/nodes/rust-prefs.md"');
    expect(result).toContain("→ ok");
    // Raw output body must NOT appear
    expect(result).not.toContain("very long file content");
  });

  it("marks failed tools with the error reason (from messages)", () => {
    const steps: CogStep[] = [
      step({
        toolCalls: [
          {
            toolCallId: "tc1",
            toolName: "readMemory",
            input: { path: "memory/nodes/missing.md" },
          },
        ],
      }),
    ];
    const messages: ModelMessage[] = [
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "readMemory",
          output: "File not found",
          isError: true,
        },
      ]),
    ];
    const result = extractCognition(messages, steps);
    expect(result).toContain("→ error: File not found");
  });

  it("shows ? when a tool-call has no matching result in messages", () => {
    const steps: CogStep[] = [
      step({
        toolCalls: [
          {
            toolCallId: "orphan",
            toolName: "webSearch",
            input: { query: "rust" },
          },
        ],
      }),
    ];
    // No tool message with this toolCallId
    const result = extractCognition([], steps);
    expect(result).toContain("→ ?");
  });

  it("skips empty reasoning text", () => {
    const steps: CogStep[] = [
      step({
        reasoning: ["", "   ", "Actual reasoning here."],
      }),
    ];
    const result = extractCognition([], steps);
    expect(result).toContain("Actual reasoning here.");
    // Empty strings should not produce separate lines
    expect(result).not.toContain("\n\n");
  });

  it("concatenates token-sized reasoning fragments instead of one per line", () => {
    // Streaming reasoning arrives as token-sized fragments ("The" + " user" + …)
    // that must be joined into continuous text, not emitted each on its own line.
    const steps: CogStep[] = [
      step({ reasoning: ["The", " user", " asks", " about", " Rust."] }),
    ];
    const result = extractCognition([], steps);
    expect(result).toContain("The user asks about Rust.");
    // The fragments must not each land on their own line.
    expect(result).not.toContain("The\n user");
  });

  it("wraps reasoning into paragraphs at blank-line boundaries", () => {
    const steps: CogStep[] = [
      step({
        reasoning: ["First paragraph.", "\n\nSecond paragraph."],
      }),
    ];
    const result = extractCognition([], steps);
    expect(result).toContain("First paragraph.");
    expect(result).toContain("Second paragraph.");
    // Paragraphs are joined by a single newline, not a blank line.
    expect(result).not.toContain("paragraph.\n\nSecond");
  });

  it("combines thinking and tools across multiple steps", () => {
    const steps: CogStep[] = [
      step({
        reasoning: ["Let me search for relevant info."],
        toolCalls: [
          {
            toolCallId: "tc1",
            toolName: "listMemory",
            input: { path: "memory/episodic/" },
          },
        ],
      }),
      step({
        toolCalls: [
          {
            toolCallId: "tc2",
            toolName: "readMemory",
            input: { path: "memory/nodes/x.md" },
          },
        ],
      }),
    ];
    const messages: ModelMessage[] = [
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "listMemory",
          output: "3 entries",
          isError: false,
        },
      ]),
      msg("tool", [
        {
          type: "tool-result",
          toolCallId: "tc2",
          toolName: "readMemory",
          output: "content",
          isError: false,
        },
      ]),
    ];
    const result = extractCognition(messages, steps);
    expect(result).toContain("### Thinking");
    expect(result).toContain("### Tools");
    expect(result).toContain("`listMemory`(path: \"memory/episodic/\") → ok");
    expect(result).toContain("`readMemory`(path: \"memory/nodes/x.md\") → ok");
    // Both tools in correct order
    const tc1Idx = result.indexOf("`listMemory`");
    const tc2Idx = result.indexOf("`readMemory`");
    expect(tc1Idx).toBeGreaterThan(-1);
    expect(tc2Idx).toBeGreaterThan(tc1Idx);
  });
});
