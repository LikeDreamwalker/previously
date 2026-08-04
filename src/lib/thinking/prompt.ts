/**
 * Thinking-agent prompt builders — pure functions shared by the think workflow
 * (buildThinkPrompt) and the main turn's integration pass (buildIntegrationPrompt).
 * Both stay in src/lib so they're unit-testable without workflow machinery.
 */
import type { ThinkInput } from "./types";

/**
 * The thinking agent's call-time user prompt. `sharedContext` is the
 * byte-identical prefix across agents dispatched in the same turn (identity +
 * previously + strands) so DeepSeek's automatic prefix cache hits for agents
 * 2-N; the question is the dynamic tail.
 */
export function buildThinkPrompt(input: ThinkInput): string {
  const formatLine = input.outputFormat
    ? `Report format: ${input.outputFormat.trim()}`
    : "";
  return [
    input.sharedContext,
    "",
    "---",
    "",
    "# Your task",
    "",
    "You are a focused analyst. Think deeply and carefully about the single",
    "question below and produce a structured markdown report. Your report will",
    "be read by the main agent, so make it self-contained and evidence-based.",
    "",
    `Question: ${input.question.trim()}`,
    "",
    formatLine,
    "",
    "Structure your report with clear sections. Where you are uncertain, say so",
    "and mark your confidence. Do not ask clarifying questions — work with what",
    "you have.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The main agent's integration prompt — wraps the finished (and any partial)
 * thinking reports so the main agent can synthesize one coherent answer.
 */
export function buildIntegrationPrompt(reportsText: string): string {
  return [
    "Here are the reports from the thinking agents you dispatched. Synthesize",
    "them into a single coherent answer to the user's question.",
    "",
    reportsText,
    "",
    "Rules:",
    "- Do NOT repeat the reports verbatim. Integrate their findings, resolve",
    "  contradictions, and write one response in your own voice.",
    "- If any report is marked `interrupted`, note the uncertainty explicitly and",
    "  work with the partial findings you have.",
    "- Keep your final answer complete and direct — this is what the user sees.",
  ].join("\n");
}
