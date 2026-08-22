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
  // Phase 0 — Housekeeping (the prep card: slice / analyze / tags /
  // context / strands) with the standalone card-evolution card at its
  // natural stream position between context and strands
  // ═══════════════════════════════════════════════════════════════════

  const emitPhase = (phase: string, running: boolean, summaries?: string[]) => ({
    apply: (msg: UIMessage) => {
      const p = cloneParts(msg);
      p.push({
        type: "data-phase",
        id: `phase-${phase}`,
        data: { phase, running, compact: true, summaries },
      });
      return setMsg(p);
    },
  });

  steps.push({ delay: 500, ...emitPhase("slice", true) });
  steps.push({ delay: 700, ...emitPhase("slice", false, ["2026-07-25-1101"]) });
  steps.push({ delay: 400, ...emitPhase("analyze", true) });
  steps.push({
    delay: 900,
    ...emitPhase("analyze", false, ["episodic-memory", "streaming-ux"]),
  });
  steps.push({ delay: 300, ...emitPhase("tags", true) });
  steps.push({
    delay: 400,
    ...emitPhase("tags", false, ["episodic-memory", "streaming-ux"]),
  });
  steps.push({ delay: 500, ...emitPhase("context", true) });

  // Card evolution (data-evolution) — its own stream-positioned card (between
  // context and strands), streaming the Previously Agent's live thinking line:
  // reading → reviewing → result. buildStream folds each frame into the single
  // "evolution" item (last chunk wins).
  steps.push({
    delay: 600,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "data-evolution",
        id: uid("evolution"),
        data: {
          status: "running",
          step: "reading",
          live: "翻开 2026-07-24 的切片，找这周聊过的偏好…",
          liveStage: "thinking",
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
        evo.data = {
          status: "running",
          step: "reading",
          live: "找到了——时间优先的整理偏好上周已经强化过一次。",
          liveStage: "thinking",
        };
      }
      return setMsg(p);
    },
  });

  steps.push({
    delay: 800,
    apply: (msg) => {
      const p = cloneParts(msg);
      const evo = p.find(
        (x: AnyPart) => x.type === "data-evolution",
      ) as AnyPart;
      if (evo) {
        evo.data = {
          status: "running",
          step: "reviewing",
          live: "kickoff-prep 那条 Now 过期了，审查是否值得沉淀…",
          liveStage: "thinking",
        };
      }
      return setMsg(p);
    },
  });

  steps.push({
    delay: 700,
    apply: (msg) => {
      const p = cloneParts(msg);
      const evo = p.find(
        (x: AnyPart) => x.type === "data-evolution",
      ) as AnyPart;
      if (evo) {
        evo.data = {
          status: "running",
          step: "reviewing",
          live: "结论：保留偏好强化，删掉过期项。",
          liveStage: "writing",
        };
      }
      return setMsg(p);
    },
  });

  steps.push({
    delay: 1100,
    apply: (msg) => {
      const p = cloneParts(msg);
      const evo = p.find(
        (x: AnyPart) => x.type === "data-evolution",
      ) as AnyPart;
      if (evo) {
        evo.data = {
          status: "done",
          changes: {
            added: 1,
            reinforced: 1,
            demoted: 0,
            removed: 1,
            superseded: 0,
          },
          hasChanges: true,
          summary:
            "Noted the time-first organization preference; dropped the stale kickoff-prep item.",
          note: "The user reiterated a systems-thinking, time-first organizational preference — reinforced the Past profile. The kickoff-prep Now item expired.",
          mutations: [
            {
              type: "added",
              text: "Now: Shipping the pure-time slicing milestone",
            },
            { type: "removed", text: "Now: Kickoff prep (expired)" },
          ],
        };
      }
      return setMsg(p);
    },
  });

  steps.push({
    delay: 400,
    ...emitPhase("context", false, ["continuity: same_day"]),
  });
  steps.push({ delay: 300, ...emitPhase("strands", true) });
  steps.push({ delay: 600, ...emitPhase("strands", false, ["12 strands"]) });

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
**Summary**: The user and agent worked through the design of a time-slice based episodic memory system. Key decisions: pure time-driven slicing (30min slice age cap = close), strand-based semantic indexing, a unified sub-agent runner for recall and deep reasoning. The slice has 7 turns and 5 decisions recorded.

**Turns**:
1. user: "I want to redesign how we store conversations" — started the memory redesign discussion
2. agent: Proposed several approaches including topic-based and time-based slicing
3. user: "What if we sliced by time instead of by topic?" — key decision point
4. agent: Walked through the implications — simpler, more predictable, no topic detection needed
5. user: "And we'd need a way to search across slices" — led to the strand concept
6. agent: Designed strands as a keyword index woven through all carrying slices — thin, lossless semantic layer over the episodic slices
7. user: "This is clean. Let's do it." — final decision recorded

**Decisions**:
- Slice closes 30 minutes after it starts (pure age cap)
- Max 50 turns per slice (safety cap)
- Strands built at slice-close via updateStrands
- One unified runner maintains metadata; the main model does deep recall`;
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

  // 4c. currentTime — the watch check (v0.9): precise now + slice progress
  steps.push({
    delay: 600,
    apply: (msg) => {
      const p = cloneParts(msg);
      p.push({
        type: "tool-currentTime",
        toolCallId: uid("tc-time"),
        toolName: "currentTime",
        state: "output-available",
        input: {},
        output: [
          "Now: 25 Jul 2026, 19:12 (Asia/Shanghai, UTC+8)",
          "UTC: 2026-07-25T11:12:00.000Z",
          "",
          "This slice (2026-07-25-1101):",
          "- Started: 25 Jul 2026, 19:01 (Asia/Shanghai) · UTC 2026-07-25T11:01:00.000Z",
          "- Running for 11 min — 19 min left of the 30-minute cap, then this slice auto-closes.",
          "",
          "Date anchors:",
          "- Today: 2026-07-25 (Sat)",
          "- This week's Monday: 2026-07-20",
          "- Last week: 2026-07-13 (Mon) → 2026-07-19 (Sun)",
          "- Tomorrow: 2026-07-26 (Sun)",
          "- This weekend: 2026-07-25 (Sat) → 2026-07-26 (Sun)",
        ].join("\n"),
      });
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

    "## Architecture Highlights\n\n### 1. Episodic Memory (Time-Slice System)\n\nYour memory is organized into **time slices** — one file per conversation window under `memory/episodic/slices/YYYY/MM/DD/HHMM.md`. A slice closes 30 minutes after it starts, or at 50 turns (safety cap).\n\n",

    "Each slice carries metadata (focus, summary, tags, emotional tone, decisions, open loops). The **worker model** maintains it; **strands** — keyword-based indexes — weave through every slice carrying a given tag, creating a thin semantic layer over the episodic store.\n\n",

    "### 2. Worker / Main Split\n\n- **Worker** (a cheap tier derived from the main model's provider) handles per-turn housekeeping — recall scanning, metadata maintenance, and the semantic gate that keeps trivial turns out of memory\n- **Main** (the model you pick in the toolbar, thinking enabled) does the actual reasoning, tool calling, and response generation — the heavy lifting\n\n",

    "### 3. Chat Rendering Pipeline\n\nThe renderer has three phases, all inline in the bubble:\n\n| Phase | Component | Icon | Purpose |\n|-------|-----------|------|---------|\n| Recall | `RecallToolRenderer` | History | Shows recall results |\n| Reasoning | `ThinkingSteps` | Brain | Shows model's internal thinking |\n| Response | `Bubble` + inline tools | — | Text + tool calls in stream order |\n\n",

    "Tool calls use `ToolLayout` — a shared expandable card pattern with spinner/dot/error states and CSS grid animation for expand/collapse. Each tool gets a dedicated renderer.\n\n",

    "> **Key insight**: GitHub files are the single source of truth for memory. Workflow is only the execution container — never a store. There is intentionally no database or KV.\n\n",

    "## Current Status (v0.7)\n\nWe're on branch `feature/v0.6-background-first`, working on:\n\n1. **User card** — previously.md is now a compact identity + profile + recent + self-model card, edited in place\n2. **Per-slice evolution** — belief evolution fires once per closed slice, not every turn\n3. **Time localization** — read tools pre-render your local time, so the agent never has to convert timezones itself\n4. **Semantic gate** — trivial turns no longer pollute tags and strands\n\n",

    "Here's the config driving the slicing behavior:\n\n```typescript\n// From lib/episodic/slicer.ts\nconst config = {\n  slicing: {\n    maxSliceMinutes: 30,     // Close slice 30min after it starts\n    maxTurnsPerSlice: 50,    // Safety cap for marathon sessions\n  },\n};\n\nfunction checkSliceAge(\n  startIso: string,\n  maxMs: number\n): boolean {\n  return Date.now() - new Date(startIso).getTime() >= maxMs;\n}\n```\n\n",

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

  return steps;
}
