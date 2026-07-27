/**
 * Demo registry — maps `demo: <id>` preview-fence IDs to live component examples.
 *
 * Each entry provides:
 * - label: short human-readable title for the card header
 * - code: the JSX source shown alongside the live render
 * - render: a function returning the rendered element (called inside a
 *           client component so hooks and interactivity work)
 *
 * Add entries here as new demo-worthy components emerge. Keep the code
 * snippets self-contained — no import statements; all dependencies are
 * already in scope via the DemoPlayground scope map.
 */
import type { ReactNode } from "react";
import { History, Brain, Search, Loader2 } from "lucide-react";
import { ToolLayout } from "@/components/chat/tool-layout";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { MarkdownRenderer } from "@/components/chat/markdown";
import { CodeBlock } from "@/components/chat/code-block";
import { ThinkingSteps } from "@/components/chat/thinking";

const COMPLETED: ReturnType<typeof import("@/lib/chat/tool-state").extractRenderState> = {
  running: false, inputStreaming: false, interrupted: false, denied: false,
  approvalRequested: false, isActiveApproval: false,
};

const RUNNING: typeof COMPLETED = {
  running: true, inputStreaming: false, interrupted: false, denied: false,
  approvalRequested: false, isActiveApproval: false,
};

export type DemoEntry = {
  id: string;
  label: string;
  code: string;
  render: () => ReactNode;
};

export const DEMO_REGISTRY: Record<string, DemoEntry> = {
  "tool-layout": {
    id: "tool-layout",
    label: "ToolLayout — expandable tool card",
    code: `<ToolLayout
  name="readSlice"
  summary="Looking up a specific slice…"
  state={COMPLETED}
  defaultExpanded
  icon={<History className="h-4 w-4" />}
  expandedContent={
    <div className="text-sm text-muted-foreground">
      Found 3 matching slices from Nov 2023 and Apr 2024.
      All three relate to the housing project and trust-crisis strand.
    </div>
  }
/>`,
    render: () => (
      <ToolLayout
        name="readSlice"
        summary="Looking up a specific slice…"
        state={COMPLETED}
        defaultExpanded
        icon={<History className="h-4 w-4" />}
        expandedContent={
          <div className="text-sm text-muted-foreground">
            Found 3 matching slices from Nov 2023 and Apr 2024.
            All three relate to the housing project and trust-crisis strand.
          </div>
        }
      />
    ),
  },
  "tool-layout-loading": {
    id: "tool-layout-loading",
    label: "ToolLayout — loading state",
    code: `<ToolLayout
  name="readTimeline"
  summary="Browsing monthly timeline…"
  state={RUNNING}
  icon={<Loader2 className="h-4 w-4 animate-spin" />}
/>`,
    render: () => (
      <ToolLayout
        name="readTimeline"
        summary="Browsing monthly timeline…"
        state={RUNNING}
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
      />
    ),
  },
  "thinking-steps": {
    id: "thinking-steps",
    label: "ThinkingSteps — Pro reasoning",
    code: `<ThinkingSteps
  text="The user is asking about the housing project again. Last time we discussed it was in April 2023, during a trust-crisis following contractor delays. I should acknowledge that context, note the time gap, and ask what specifically they want to revisit — the contractor issue, the community communication strategy, or something new."
  durationMs={2340}
/>`,
    render: () => (
      <ThinkingSteps
        text="The user is asking about the housing project again. Last time we discussed it was in April 2023, during a trust-crisis following contractor delays. I should acknowledge that context, note the time gap, and ask what specifically they want to revisit — the contractor issue, the community communication strategy, or something new."
        durationMs={2340}
      />
    ),
  },
  "bubble-variants": {
    id: "bubble-variants",
    label: "Bubble — variant gallery",
    code: `<div className="flex flex-col gap-3">
  <Bubble variant="default">
    <BubbleContent>Default — the primary agent response bubble</BubbleContent>
  </Bubble>
  <Bubble variant="secondary">
    <BubbleContent>Secondary — muted context or tool output</BubbleContent>
  </Bubble>
  <Bubble variant="outline">
    <BubbleContent>Outline — subtle framing for notes or asides</BubbleContent>
  </Bubble>
  <Bubble variant="tinted">
    <BubbleContent>Tinted — key takeaway or highlighted insight</BubbleContent>
  </Bubble>
</div>`,
    render: () => (
      <div className="flex flex-col gap-3">
        <Bubble variant="default">
          <BubbleContent>Default — the primary agent response bubble</BubbleContent>
        </Bubble>
        <Bubble variant="secondary">
          <BubbleContent>Secondary — muted context or tool output</BubbleContent>
        </Bubble>
        <Bubble variant="outline">
          <BubbleContent>Outline — subtle framing for notes or asides</BubbleContent>
        </Bubble>
        <Bubble variant="tinted">
          <BubbleContent>Tinted — key takeaway or highlighted insight</BubbleContent>
        </Bubble>
      </div>
    ),
  },
  "markdown-renderer": {
    id: "markdown-renderer",
    label: "MarkdownRenderer — GFM with syntax highlighting",
    code: `<MarkdownRenderer content={\`## Memory Model

The Previously memory system has **two layers**:

| Layer | Storage | Purpose |
|-------|---------|---------|
| Episodic | Time slices | Events tied to *when* |
| Semantic | Strands + nodes | Knowledge about *what* |

> Slice = what happened. Strand = what it was about.
\`} />`,
    render: () => (
      <MarkdownRenderer
        content={`## Memory Model

The Previously memory system has **two layers**:

| Layer | Storage | Purpose |
|-------|---------|---------|
| Episodic | Time slices | Events tied to *when* |
| Semantic | Strands + nodes | Knowledge about *what* |

> Slice = what happened. Strand = what it was about.`}
      />
    ),
  },
  "code-block": {
    id: "code-block",
    label: "CodeBlock — fenced code with copy",
    code: `<CodeBlock
  language="typescript"
  code={\`export async function readFileLocal(path: string): Promise<string> {
  const fullPath = join(DATA_ROOT, resolveDemoPath(path));
  if (!existsSync(fullPath)) {
    throw new Error(\\\`File not found: "\\\${path}"\\\`);
  }
  return readFileSync(fullPath, "utf-8");
}\`}
/>`,
    render: () => (
      <CodeBlock
        language="typescript"
        code={`export async function readFileLocal(path: string): Promise<string> {\n  const fullPath = join(DATA_ROOT, resolveDemoPath(path));\n  if (!existsSync(fullPath)) {\n    throw new Error(\`File not found: "\${path}"\`);\n  }\n  return readFileSync(fullPath, "utf-8");\n}`}
      />
    ),
  },
  "slice-file": {
    id: "slice-file",
    label: "Slice file — Markdown with YAML frontmatter",
    code: `---
slice_id: 2023-04-21-0610
focus: Housing project delays and trust crisis management
status: closed
start: "2023-04-21T06:10:00.000Z"
end: "2023-04-21T07:18:00.000Z"
timezone: America/Chicago
summary: Contractor qualification and property deed mismatches stalled
  multiple household files, triggering a community trust crisis.
decisions:
  - Prioritize direct phone calls to affected households
  - Use "real blocker + specific next step" frame
open_loops:
  - Whether overall community trust can recover after timeline delays
  - How to balance individual calls and collective meetings
tags:
  - work-pressure
  - housing-project
  - trust-crisis
emotional_tone: mixed
---

## Turn 1 — 2023-04-21T06:10:00.000Z (user)

The housing rehab files that were supposed to close this month are
stalled again. At the public meeting last night residents were angry.

## Turn 2 — 2023-04-21T06:13:00.000Z (agent)

That sounds rough. What specifically broke down — contractor
qualification, property deeds, or something else?`,
    render: () => (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          A slice is a single Markdown file — YAML frontmatter for structured
          metadata, then conversation turns in the body. Human-readable,
          git-diffable, tool-agnostic.
        </p>
        <CodeBlock
          language="markdown"
          code={`---
slice_id: 2023-04-21-0610
focus: Housing project delays and trust crisis management
status: closed
start: "2023-04-21T06:10:00.000Z"
end: "2023-04-21T07:18:00.000Z"
timezone: America/Chicago
summary: Contractor qualification and property deed mismatches stalled
  multiple household files, triggering a community trust crisis.
decisions:
  - Prioritize direct phone calls to affected households
  - Use "real blocker + specific next step" frame
open_loops:
  - Whether overall community trust can recover after timeline delays
  - How to balance individual calls and collective meetings
tags:
  - work-pressure
  - housing-project
  - trust-crisis
emotional_tone: mixed
---

## Turn 1 — user

The housing rehab files that were supposed to close this month are
stalled again. At the public meeting last night residents were angry.

## Turn 2 — agent

That sounds rough. What specifically broke down — contractor
qualification, property deeds, or something else?`}
        />
      </div>
    ),
  },
  "strands-index": {
    id: "strands-index",
    label: "Strands index — keyword → slice mapping",
    code: `{
  "work-pressure": [
    "memory/demo/personal_14/episodic/slices/2022/05/18/0525.md",
    "memory/demo/personal_14/episodic/slices/2023/04/21/0610.md",
    "memory/demo/personal_14/episodic/slices/2024/11/08/0930.md",
    "memory/demo/personal_14/episodic/slices/2025/02/14/1445.md"
  ],
  "housing-project": [
    "memory/demo/personal_14/episodic/slices/2023/04/21/0610.md",
    "memory/demo/personal_14/episodic/slices/2023/07/12/1530.md",
    "memory/demo/personal_14/episodic/slices/2024/03/05/0800.md"
  ],
  "trust-crisis": [
    "memory/demo/personal_14/episodic/slices/2023/04/21/0610.md",
    "memory/demo/personal_14/episodic/slices/2023/05/10/1630.md"
  ],
  "community-communication": [
    "memory/demo/personal_14/episodic/slices/2023/04/21/0610.md",
    "memory/demo/personal_14/episodic/slices/2024/11/08/0930.md"
  ],
  "family": [
    "memory/demo/personal_14/episodic/slices/2022/01/08/1130.md",
    "memory/demo/personal_14/episodic/slices/2025/02/14/1445.md"
  ]
}`,
    render: () => (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <code className="font-mono">memory/episodic/strands.json</code> maps
          every keyword (tag) to every slice that carries it. Built at
          slice-close — a thin, lossless semantic index over the episodic
          timeline. The{" "}
          <code className="font-mono">work-pressure</code> strand links 4
          slices spanning 2022 to 2025.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "work-pressure": [
    "memory/.../slices/2022/05/18/0525.md",
    "memory/.../slices/2023/04/21/0610.md",
    "memory/.../slices/2024/11/08/0930.md",
    "memory/.../slices/2025/02/14/1445.md"
  ],
  "housing-project": [
    "memory/.../slices/2023/04/21/0610.md",
    "memory/.../slices/2023/07/12/1530.md",
    "memory/.../slices/2024/03/05/0800.md"
  ],
  "trust-crisis": [
    "memory/.../slices/2023/04/21/0610.md",
    "memory/.../slices/2023/05/10/1630.md"
  ],
  "community-communication": [
    "memory/.../slices/2023/04/21/0610.md",
    "memory/.../slices/2024/11/08/0930.md"
  ],
  "family": [
    "memory/.../slices/2022/01/08/1130.md",
    "memory/.../slices/2025/02/14/1445.md"
  ]
}`}
        />
      </div>
    ),
  },
};

export function getDemoEntry(id: string): DemoEntry | undefined {
  return DEMO_REGISTRY[id];
}
