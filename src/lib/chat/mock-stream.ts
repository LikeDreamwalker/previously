/**
 * Mock streaming sequence — builds a fake UIMessage with progressively
 * arriving parts to demonstrate all rendering capabilities.
 *
 * This is a demo/testing utility. Casts are intentional — mock data shapes
 * may not fully satisfy the AI SDK's strict discriminated union types.
 */

import type { UIMessage } from "ai";


type AnyPart = any;

export interface MockStep {
  delay: number;
  apply: (msg: UIMessage) => UIMessage;
}

let _idCounter = 0;
function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

function cloneParts(msg: UIMessage): AnyPart[] {
  return [...(msg.parts ?? [])] as AnyPart[];
}

export function buildMockSteps(): MockStep[] {
  const messageId = uid("demo-msg");

  function setMsg(parts: AnyPart[]): UIMessage {
    return {
      id: messageId,
      role: "assistant",
      parts,
      createdAt: new Date(),
    } as UIMessage;
  }

  const steps: MockStep[] = [];

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1 — Reasoning (thinking aloud)
  // ═══════════════════════════════════════════════════════════════════

  steps.push({
    delay: 1200,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "reasoning",
        text: "The user is asking about what we've discussed before regarding the project architecture. Let me think about this methodically.",
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1500,
    apply: (msg) => {
      const p = cloneParts(msg);
      const last = p[p.length - 1];
      last.text +=
        "\n\nI should start by recalling relevant memory slices across the episodic timeline. The worker model handles the fast scan, then I deep-read the most relevant slices myself. We also talked about the user card — let me check what I already believe about this person.";
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1200,
    apply: (msg) => {
      const p = cloneParts(msg);
      const last = p[p.length - 1];
      last.text +=
        "\n\nIf recall turns up nothing concrete, I should say so plainly rather than invent a memory. Let me run the scan and see what comes back.";
      return setMsg(p);
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 — Recall tool (PhaseIndicator static mode)
  // ═══════════════════════════════════════════════════════════════════

  steps.push({
    delay: 1000,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-recall",
        toolCallId: uid("tc-recall"),
        toolName: "recall",
        state: "input-streaming",
        input: { query: "" },
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 800,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].input = { query: "project architecture decisions" };
      return setMsg(p);
    },
  });

  steps.push({
    delay: 600,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].input = {
        query:
          "project architecture decisions, episodic memory design, streaming UX improvements, and the user card",
      };
      p[p.length - 1].state = "input-available";
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1500,
    apply: (msg) => {
      const p = cloneParts(msg);
      const recallPart = p.find(
        (x: AnyPart) => x.type === "tool-recall",
      ) as AnyPart;
      if (recallPart) {
        recallPart.state = "output-available";
        recallPart.output = {
        hits: [
          {
            slice_id: "2026-07-24-1500",
            relevance: 0.95,
            reason:
              "Detailed discussion about episodic memory architecture — the user proposed the time-slice approach and we designed the worker/main split for recall vs deep reasoning. Covered strand-based semantic indexing.",
            key_turns: [1, 3, 5, 7],
          },
          {
            slice_id: "2026-07-24-1700",
            relevance: 0.87,
            reason:
              "Streaming UX improvements for the chat interface — tool calls rendered inline with expandable cards, reasoning shown in ThinkingSteps blocks with elapsed timers.",
            key_turns: [2, 4, 6],
          },
          {
            slice_id: "2026-07-25-0900",
            relevance: 0.72,
            reason:
              "The user card redesign — previously.md becomes a compact identity + profile + recent + self-model card, evolved once per closed slice instead of every turn.",
          },
          {
            slice_id: "2026-07-24-1200",
            relevance: 0.58,
            reason:
              "Brief mention of the product concept and 'I come after you're done' philosophy during the project kickoff discussion.",
          },
        ],
        rawContents: {
          "2026-07-24-1500":
            "user: I want to redesign how we store conversations\nagent: Let me think about the best approach…\nuser: What if we sliced by time instead of by topic?\nagent: That's cleaner — pure time-driven slicing with no capacity rules means the system is simpler and more predictable.\nuser: And we'd need a way to search across slices…\nagent: Strands — a keyword index woven through every slice that carries it.",
          "2026-07-24-1700":
            "user: The chat rendering feels bare. Can we make it feel more alive?\nagent: We could show tool calls inline as they happen, with expand/collapse animations.\nuser: What about the reasoning?\nagent: ThinkingSteps — a dedicated block with a brain icon and an elapsed timer. The user sees what the model is thinking in real time.",
        },
        confidence: 0.92,
        reasoning:
          "Found 4 relevant slices. The top 2 hits (confidence 0.95, 0.87) cover the core architecture discussions. The third covers the user card redesign. The fourth is a weaker match for the kickoff conversation.",
        };
      }
      return setMsg(p);
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3 — Multiple memory tools (readSlice, readStrand, readPreviously)
  // ═══════════════════════════════════════════════════════════════════

  // 3a. readSlice — the primary hit
  steps.push({
    delay: 900,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-readSlice",
        toolCallId: uid("tc-readslice"),
        toolName: "readSlice",
        state: "input-streaming",
        input: {},
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 500,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].input = { sliceId: "2026-07-24-1500" };
      p[p.length - 1].state = "input-available";
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1500,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].state = "output-available";
      p[p.length - 1].output = `## Slice 2026-07-24-1500

**Focus**: Episodic memory architecture redesign
**Summary**: The user and agent worked through the design of a time-slice based episodic memory system. Key decisions: pure time-driven slicing (30min silence = close), strand-based semantic indexing, worker/main split for recall vs deep reasoning. The slice has 7 turns and 5 decisions recorded.

**Turns**:
1. user: "I want to redesign how we store conversations" — started the memory redesign discussion
2. agent: Proposed several approaches including topic-based and time-based slicing
3. user: "What if we sliced by time instead of by topic?" — key decision point
4. agent: Walked through the implications — simpler, more predictable, no topic detection needed
5. user: "And we'd need a way to search across slices" — led to the strand concept
6. agent: Designed strands as a keyword index woven through all carrying slices — thin, lossless semantic layer over the episodic slices
7. user: "This is clean. Let's do it." — final decision recorded

**Decisions**:
- 30-minute time silence closes slice
- Max 40 turns per slice (safety cap)
- Strands built at slice-close via updateStrands
- Worker model maintains metadata; the main model does deep recall`;
      return setMsg(p);
    },
  });

  // 3b. readStrand — follow the "streaming-ux" tag
  steps.push({
    delay: 800,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-readStrand",
        toolCallId: uid("tc-strand"),
        toolName: "readStrand",
        state: "input-streaming",
        input: {},
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 400,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].input = { strand: "streaming-ux" };
      p[p.length - 1].state = "input-available";
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1200,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].state = "output-available";
      p[p.length - 1].output = {
        strand: "streaming-ux",
        slices: [
          {
            id: "2026-07-24-1700",
            focus: "Chat rendering UX improvements",
            summary:
              "Worked on making the agent's process visible — tool calls inline with expandable cards, reasoning in ThinkingSteps, streaming cursor.",
          },
          {
            id: "2026-07-25-1101",
            focus: "Phase indicator and streaming events",
            summary:
              "Explored adding phase-level streaming events for the pre-agent pipeline. Ultimately decided against it due to Workflow step batching constraints. Updated loading indicator instead.",
          },
        ],
      };
      return setMsg(p);
    },
  });

  // 3c. readPreviously — the v0.7 user card
  steps.push({
    delay: 700,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-readPreviously",
        toolCallId: uid("tc-prev"),
        toolName: "readPreviously",
        state: "input-available",
        input: { sliceId: "2026-07-25-1101" },
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1000,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].state = "output-available";
      p[p.length - 1].output = `## Previously on…

### Identity
- Name: the user
- Preferred handle: no preference stated
- Pronouns: —

### Past
A full-stack engineer who thinks in systems. Prefers clean architecture with clear separation of concerns, and a streaming-first UX — hates waiting without feedback. Values time-based organization over topic-based filing.

### Now
- Redesigning the memory layer — user card + per-slice evolution
- Streaming UX polish for the chat response flow

### Horizon
- Ship the v5 card redesign — by: next milestone

### Self-model
- diff from baseline: prefers Rust for business logic, React for UI (noted, but the conversation is product-first)`;
      return setMsg(p);
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4 — Web search (regular tool, manual expand)
  // ═══════════════════════════════════════════════════════════════════

  steps.push({
    delay: 1000,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-webSearch",
        toolCallId: uid("tc-web"),
        toolName: "webSearch",
        state: "input-streaming",
        input: {},
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 600,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].input = {
        query: "Vercel AI SDK WorkflowAgent streaming tool calls 2025",
      };
      p[p.length - 1].state = "input-available";
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1500,
    apply: (msg) => {
      const p = cloneParts(msg);
      const webPart = p.find(
        (x: AnyPart) => x.type === "tool-webSearch",
      ) as AnyPart;
      if (webPart) {
        webPart.state = "output-available";
        webPart.output = {
        answer:
          "The **Vercel AI SDK v7** (`@ai-sdk/workflow`) introduces the `WorkflowAgent` class which wraps the standard AI SDK `streamText` in a durable execution container. Key points:\n\n- Each LLM call and each tool call becomes an individually **durable, auto-retried workflow step**\n- Tool executors are standalone `\"use step\"` functions — the workflow runtime retries them on transient failures\n- The `stream()` method accepts a `writable` parameter so tool output can be streamed back to the client in real time\n- `WorkflowChatTransport` on the client side handles **auto-reconnect** on dropped connections and **post-reload resume** via a `localStorage` run id\n- The workflow body runs deterministically — no `Date.now()`, `Math.random()`, or Node.js modules allowed; these are injected through the step boundary",
        sources: [
          "https://sdk.vercel.ai/docs/reference/ai-sdk-workflow",
          "https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calls",
          "https://vercel.com/blog/durable-ai-agents-with-vercel-workflow",
        ],
        };
      }
      return setMsg(p);
    },
  });

  // 4b. A tool that errors — demonstrates error rendering
  steps.push({
    delay: 800,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-listSlices",
        toolCallId: uid("tc-listslices"),
        toolName: "listSlices",
        state: "input-streaming",
        input: {},
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 500,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].input = { year: 2024, month: 13 };
      p[p.length - 1].state = "input-available";
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1000,
    apply: (msg) => {
      const p = cloneParts(msg);
      p[p.length - 1].state = "output-error";
      p[p.length - 1].errorText =
        "Error: Invalid month value: 13. Month must be between 1 and 12.";
      return setMsg(p);
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5 — Text response (rich markdown streaming)
  // ═══════════════════════════════════════════════════════════════════

  const textChunks = [
    "Okay, I've gathered quite a bit of context. Let me synthesize everything into a clear picture of where we are and where we're heading.\n\n",

    "## Previously — an agent that remembers by time\n\n**Previously** is a cloud agent with episodic memory. Instead of chat threads, it organizes everything into **time slices** — one Markdown file per conversation burst, stored in your own GitHub repository. No database, no vector store, no proprietary format.\n\n",

    "The stack: **Next.js 16** + **React 19** + **TypeScript 6** + **Tailwind CSS 4** + **shadcn/ui** on the frontend, with **Vercel Workflow** powering durable agent execution and **GitHub** as the single source of truth.\n\n",

    "## Architecture Highlights\n\n### 1. Episodic Memory (Time-Slice System)\n\nYour memory is organized into **time slices** — one file per conversation window under `memory/episodic/slices/YYYY/MM/DD/HHMM.md`. A slice closes after 30 minutes of inactivity or 40 turns (safety cap).\n\n",

    "Each slice carries metadata (focus, summary, tags, emotional tone, decisions, open loops). The **worker model** maintains it; **strands** — keyword-based indexes — weave through every slice carrying a given tag, creating a thin semantic layer over the episodic store.\n\n",

    "### 2. Worker / Main Split\n\n- **Worker** (a cheap tier derived from the main model's provider) handles per-turn housekeeping — recall scanning, metadata maintenance, and the semantic gate that keeps trivial turns out of memory\n- **Main** (the model you pick in the toolbar, thinking enabled) does the actual reasoning, tool calling, and response generation — the heavy lifting\n\n",

    "### 3. Chat Rendering Pipeline\n\nThe renderer has three phases, all inline in the bubble:\n\n| Phase | Component | Icon | Purpose |\n|-------|-----------|------|---------|\n| Recall | `RecallToolRenderer` | History | Shows recall results |\n| Reasoning | `ThinkingSteps` | Brain | Shows model's internal thinking |\n| Response | `Bubble` + inline tools | — | Text + tool calls in stream order |\n\n",

    "Tool calls use `ToolLayout` — a shared expandable card pattern with spinner/dot/error states and CSS grid animation for expand/collapse. Each tool gets a dedicated renderer.\n\n",

    "### 4. Background Loops\n\nDurable background tasks run as separate Vercel Workflow runs. The `startLoop` tool spawns them from chat, and `LoopWatcher` on the client subscribes to their progress. Each loop calls `loopReport` to checkpoint progress back to the repository.\n\n",

    "> **Key insight**: GitHub files are the single source of truth for memory. Workflow is only the execution container — never a store. There is intentionally no database or KV.\n\n",

    "## Current Status (v0.7)\n\nWe're on branch `feature/v0.6-background-first`, working on:\n\n1. **User card** — previously.md is now a compact identity + profile + recent + self-model card, edited in place\n2. **Per-slice evolution** — belief evolution fires once per closed slice, not every turn\n3. **Time localization** — read tools pre-render your local time, so the agent never has to convert timezones itself\n4. **Semantic gate** — trivial turns no longer pollute tags and strands\n\n",

    "Here's the config driving the slicing behavior:\n\n```typescript\n// From lib/episodic/slicer.ts\nconst config = {\n  slicing: {\n    timeSilenceMinutes: 30,  // Close slice after 30min idle\n    maxTurnsPerSlice: 40,    // Safety cap for marathon sessions\n  },\n};\n\nfunction checkTimeSilence(\n  lastActivity: number,\n  silenceMs: number\n): boolean {\n  return Date.now() - lastActivity > silenceMs;\n}\n```\n\n",

    "## What's Next\n\n- [ ] First-class strands — a rolling summary + recall integration for each strand\n- [ ] Explicit memory-update confirmations — the agent proposes, you approve\n- [ ] Richer cross-slice navigation on the horizontal timeline\n- [ ] More demo personas for the read-only demo\n\n",

    "Let me know which direction you want to focus on!",
  ];

  for (const chunk of textChunks) {
    steps.push({
      delay: 600 + Math.random() * 500,
      apply: (msg) => {
        const p = cloneParts(msg);
        const lastText = [...p].reverse().find(
          (x: AnyPart) => x.type === "text",
        ) as AnyPart;
        if (lastText) {
          lastText.text += chunk;
        } else {
          p.push({ type: "text", text: chunk });
        }
        return setMsg(p);
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 6 — Self-evolution (v0.7 data-evolution part)
  // ═══════════════════════════════════════════════════════════════════

  steps.push({
    delay: 800,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "data-evolution",
        id: uid("evolution"),
        data: {
          running: true,
          step: "reading",
        },
      });
      return setMsg(p);
    },
  });

  steps.push({
    delay: 900,
    apply: (msg) => {
      const p = cloneParts(msg);
      const evo = p.find(
        (x: AnyPart) => x.type === "data-evolution",
      ) as AnyPart;
      if (evo) {
        evo.data = { running: true, step: "reviewing" };
      }
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1000,
    apply: (msg) => {
      const p = cloneParts(msg);
      const evo = p.find(
        (x: AnyPart) => x.type === "data-evolution",
      ) as AnyPart;
      if (evo) {
        evo.data = {
          running: false,
          changes: {
            added: 1,
            reinforced: 1,
            demoted: 0,
            removed: 1,
            superseded: 0,
          },
          hasChanges: true,
        };
      }
      return setMsg(p);
    },
  });

  return steps;
}
