import { describe, it, expect, vi } from "vitest";
import type { UIMessage } from "ai";

// start-turn.ts is a route module — stub its workflow boundary so importing it
// for the pure helpers below stays hermetic.
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: vi.fn() }));

import { summarizeModelContent, stripFileParts } from "@/app/api/chat/start-turn";

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
