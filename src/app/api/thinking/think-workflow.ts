/**
 * Durable thinking-agent workflow — the "deep worker" behind the thinkDeep tool.
 *
 * A thinking agent is a focused analyst with thinking ENABLED at the dispatched
 * effort level. It works ONE bounded question and writes a structured report to
 * memory/thinking/<thinkId>/report.md (see finalizeThink in ./steps). It runs
 * in its OWN workflow run, so the dispatching step never waits on it — the main
 * turn polls the report files via durable sleeps and integrates when they land.
 *
 * Deterministic controller: no direct I/O here. The agent brain comes from
 * createThinkAgent (src/app/api/agent/), the report write from the `"use step"`
 * finalizeThink. Same Layer 1 protections as chat/loops: per-call token cap +
 * wall-clock timeout keep a single LLM step under Vercel's 300s limit.
 *
 * Lives under src/app so the withWorkflow loader picks up `"use workflow"`.
 */
import { isStepCount } from "ai";
import { getWritable } from "workflow";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { createThinkAgent } from "@/app/api/agent/agent";
import { buildThinkToolsContext } from "@/app/api/agent/tools";
import { extractFinalText } from "@/app/api/chat/turn-workflow";
import { buildThinkPrompt } from "@/lib/thinking/prompt";
import type { ThinkInput, ThinkResult } from "@/lib/thinking/types";
import { finalizeThink } from "./steps";

export async function thinkWorkflow(input: ThinkInput): Promise<ThinkResult> {
  "use workflow";

  const agent = createThinkAgent({
    model: input.model,
    effort: input.effort,
    toolsContext: buildThinkToolsContext({
      repo: input.repo,
      owner: input.owner,
      useGithub: input.useGithub,
      useDemo: false,
      sliceId: "",
      recentTurns: [],
    }),
  });

  let status: "completed" | "interrupted";
  let content = "";
  try {
    const result = await agent.stream({
      prompt: buildThinkPrompt(input),
      writable: getWritable<ModelCallStreamPart>(),
      stopWhen: isStepCount(15),
      // Layer 1: cap the generation so a long thinking generation can't hit
      // Vercel's 300s per-step limit. No `timeout` — the workflow sandbox
      // lacks the AbortSignal global the SDK's timeout option uses.
      maxOutputTokens: 8_000,
      // finalizeThink owns the stream tail.
      sendFinish: false,
      preventClose: true,
    });
    content = extractFinalText(result.messages);
    status = "completed";
  } catch (err) {
    status = "interrupted";
    content = "";
    console.warn(
      `[Thinking] agent stream failed (think=${input.thinkId}):`,
      err instanceof Error ? err.message : err,
    );
  }

  return await finalizeThink(input, status, content);
}
