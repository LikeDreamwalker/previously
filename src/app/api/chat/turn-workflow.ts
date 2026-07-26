/**
 * Durable chat-turn workflow — every chat turn runs inside one of these.
 *
 * The deterministic controller: NO direct I/O and no Node.js modules in its
 * import graph. It threads the time-slice by value through the steps,
 * re-binding it after each mutating step (the module-global `activeSlice` is
 * unusable here — steps run in separate invocations).
 *
 * The Pro agent loop runs HERE, in the workflow body, via WorkflowAgent
 * (AI SDK 7 `@ai-sdk/workflow`): each LLM call and each tool call becomes its
 * own durable step (tool executors are standalone `"use step"` functions in
 * src/app/api/agent/tool-executors.ts). Everything else — slice housekeeping,
 * Flash recall, prompt assembly, persistence — lives behind the `"use step"`
 * functions in ./steps, imported here by reference only.
 *
 * GitHub remains the source of truth for memory: the steps write slices,
 * indexes, strands, notes, and loop files straight to the repo. The workflow is
 * only the execution container that makes the turn durable and resumable.
 *
 * Lives under src/app so the `withWorkflow` loader (which scans app/src/app by
 * default) picks up the `"use workflow"` directive.
 */
import { isStepCount, type ModelMessage } from "ai";
import { getWritable } from "workflow";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { createChatAgent } from "@/app/api/agent/agent";
import { buildChatToolsContext } from "@/app/api/agent/tools";
import type {
  TurnInput,
  TurnOutcome,
  StartedLoopRef,
} from "@/lib/chat/turn-types";
import {
  housekeeping,
  seedPreviously,
  finalizeTurn,
} from "./steps";

// ─── Pure helpers (serializable data in, serializable data out) ──────────

/** Final assistant text from the agent's message history. */
function extractFinalText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" &&
            p !== null &&
            (p as { type?: string }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string"
        )
        .map((p) => p.text)
        .join("");
    }
    return "";
  }
  return "";
}

/**
 * Mechanically extract the agent's cognitive process from its message history
 * AND step results.
 *
 * IMPORTANT: In the WorkflowAgent, `result.messages` does NOT contain reasoning
 * parts — the agent strips them when building `conversationPrompt` (see
 * stream-text-iterator.ts:399-415). Reasoning is preserved only in
 * `result.steps[].reasoning`. Tool-call→result statuses are resolved from
 * tool-role messages in `result.messages`.
 *
 * This function merges both sources:
 *   - Reasoning + tool calls → from steps
 *   - Tool results (ok/error) → from messages
 */
export function extractCognition(
  messages: ModelMessage[],
  steps: unknown,
): string {
  const lines: string[] = [];

  // Collect tool-call→result pairs by matching toolCallId across messages.
  const toolResults = new Map<string, { ok: boolean; error?: string }>();

  for (const m of messages) {
    if (m.role !== "tool") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const part of parts) {
      const p = part as { type?: string; toolCallId?: string; toolName?: string; output?: unknown; isError?: boolean };
      if (p.type !== "tool-result" || typeof p.toolCallId !== "string") continue;
      const isError = p.isError === true;
      const outputStr = typeof p.output === "string" ? p.output : "";
      toolResults.set(p.toolCallId, {
        ok: !isError,
        error: isError ? (outputStr.slice(0, 200) || "unknown error") : undefined,
      });
    }
  }

  // Process each step: reasoning + tool calls with result status from messages.
  const stepsArray = Array.isArray(steps) ? steps : [];
  for (const step of stepsArray) {
    const stepObj = step as Record<string, unknown>;
    // ── Reasoning (from steps — NOT available in messages) ──────────
    const reasoning = stepObj.reasoning as Array<{ type: string; text?: string; data?: unknown }> | undefined;
    if (reasoning && reasoning.length > 0) {
      lines.push("\n### Thinking");
      for (const r of reasoning) {
        const content: unknown = typeof r.text === "string" ? r.text : r.data;
        if (typeof content === "string" && content.trim()) {
          lines.push(content);
        }
      }
    }

    // ── Tool calls (from steps, enriched with result status from messages) ──
    const toolCalls = stepObj.toolCalls as Array<{ toolCallId: string; toolName: string; input: unknown }> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      lines.push("\n### Tools");
      for (const tc of toolCalls) {
        const params = summarizeToolInput(tc.input);
        const result = toolResults.get(tc.toolCallId);
        const status = result
          ? result.ok
            ? "ok"
            : `error: ${result.error}`
          : "?";
        lines.push(`- \`${tc.toolName}\`(${params}) → ${status}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

/** Compact single-line representation of tool parameters. */
function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .slice(0, 5); // cap at 5 params to keep each line scannable
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v.slice(0, 80)}${v.length > 80 ? "…" : ""}"` : JSON.stringify(v)}`)
    .join(", ");
}

/**
 * Successful startLoop tool results → slice writeback refs.
 *
 * Extracted from the agent's MESSAGE history, not `result.steps`: after the
 * workflow serialization boundary a step's `content` carries only the
 * tool-call part (the tool RESULT lands in a `role: "tool"` message), so the
 * `toolResults` getter on steps is always empty here. Tags come from the
 * matching assistant tool-call input; the loopId from the tool result.
 */
function extractStartedLoops(messages: ModelMessage[]): StartedLoopRef[] {
  const tagsByCallId = new Map<string, string[]>();
  const refs: StartedLoopRef[] = [];

  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      for (const part of m.content) {
        const p = part as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          input?: { tags?: unknown };
        };
        if (
          p.type === "tool-call" &&
          p.toolName === "startLoop" &&
          typeof p.toolCallId === "string"
        ) {
          const tags = Array.isArray(p.input?.tags)
            ? p.input.tags.filter((t): t is string => typeof t === "string")
            : [];
          tagsByCallId.set(p.toolCallId, tags);
        }
      }
    } else if (m.role === "tool") {
      for (const part of m.content) {
        const p = part as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          output?: unknown;
        };
        if (p.type !== "tool-result" || p.toolName !== "startLoop") continue;
        // ModelMessage tool-result output is wrapped ({ type: 'json', value }).
        const raw = p.output as { value?: unknown } | undefined;
        const value = (
          raw && typeof raw === "object" && "value" in raw ? raw.value : raw
        ) as { ok?: unknown; loopId?: unknown } | undefined;
        if (!value || value.ok !== true || typeof value.loopId !== "string") {
          continue;
        }
        refs.push({
          loopId: value.loopId,
          tags: tagsByCallId.get(p.toolCallId ?? "") ?? [],
        });
      }
    }
  }
  return refs;
}

// ─── The workflow ────────────────────────────────────────────────────────

export async function turnWorkflow(input: TurnInput): Promise<void> {
  "use workflow";

  // ── Pre-turn steps ─────────────────────────────────────────────────────

  const { slice } = await housekeeping(input);
  const previouslyContent = await seedPreviously(slice.slice_id);

  // ── Assemble system prompt ──────────────────────────────────────────────

  const systemPrompt = `## 我对你的理解

${previouslyContent}

以上是我目前对你的了解。如果有任何过时或错误的，告诉我，我会更新。

## 记忆访问规则

当你需要从过去的对话中获取上下文时，按以下顺序操作：

1. **先 recall。** 调用 \`recall\` 搜索情景记忆。回忆 agent 返回指针（哪些切片、哪些轮次、为什么相关）。在 recall 返回结果之前，不要调用 readSlice、readTimeline、readStrand 或 listStrands。
2. **如需深入，再读取。** recall 返回后，调用 \`readSlice\` 获取特定切片的内容。使用 \`range\` 参数只获取你需要的内容：
   - \`range: { type: "last", count: 3 }\` — 获取切片最后 3 轮
   - \`range: { type: "turns", indices: [0, 5, 7] }\` — 获取特定轮次
   - \`range: { type: "date", after: "2026-07-24T00:00:00Z" }\` — 获取某日期之后的轮次
   - 省略 \`range\` 获取完整切片（谨慎用于大型切片）
3. **进一步探索。** 使用 \`readStrand\` 或 \`readTimeline\` 仅用于跟进 recall 结果中的线索。

**以时间思考。** 当 recall 返回结果时，优先选择更近的切片——用户当前的状态通常最重要。当你引用过去的对话时，加入时间锚点（"你上周二提到过……"而不是"你提到过……"），让用户知道你把时间线放对了。从上次之后发生了什么变化，往往比当时说了什么更有用。

你可以用 \`webSearch\` 搜索实时网络以获取当前信息，并在相关时引用到回复中。
你可以用 \`startLoop\` 启动持久的后台循环任务。当用户要求持续或后台工作，或者你判断任务足够大或足够长，可以在后台自主工作时调用。告诉用户你启动了。`;

  // ── Pro agent ──────────────────────────────────────────────────────────

  const agent = createChatAgent({
    modelId: input.model,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    toolsContext: buildChatToolsContext({
      repo: input.repo,
      owner: input.owner,
      useGithub: input.useGithub,
      useDemo: input.useDemo,
      sliceId: slice.slice_id,
      recentTurns: input.recentTurns,
    }),
  });

  let outcome: TurnOutcome;
  let streamError: unknown = null;
  try {
    const result = await agent.stream({
      messages: input.modelMessages,
      system: systemPrompt,
      writable: getWritable<ModelCallStreamPart>(),
      stopWhen: isStepCount(20),
      sendFinish: false,
      preventClose: true,
    });
    outcome = {
      text: extractFinalText(result.messages),
      finishReason: result.finishReason,
      startedLoops: extractStartedLoops(result.messages),
      cognition: extractCognition(result.messages, result.steps),
    };
  } catch (err) {
    streamError = err;
    outcome = { text: "", finishReason: "error", startedLoops: [], cognition: "" };
  }

  // ── Post-turn persistence ──────────────────────────────────────────────

  await finalizeTurn(slice, outcome, input.turnId);

  if (streamError !== null) {
    throw streamError;
  }
}
