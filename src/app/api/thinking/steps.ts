/**
 * Thinking-agent step functions — full Node.js, retried automatically.
 *
 * Kept separate from the think workflow so Node-dependent imports (gray-matter,
 * the store) never enter the deterministic workflow sandbox. Two responsibilities:
 *   - finalizeThink   — write the agent's report (or an interrupted stub) to
 *                       memory/thinking/<thinkId>/report.md and close the stream
 *   - allReportsReady / readAllReports — the MAIN turn's wait-loop polls these
 *     (via the shared report files) to know when every dispatched agent has
 *     settled, then assembles the integration input.
 */
import { type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import type { ThinkInput, ThinkReport, ThinkStatus } from "@/lib/thinking/types";
import { readReport, reportExists, writeReport } from "@/lib/thinking/store";
import { writeTurnState, readTurnState } from "@/lib/sessions/store";

/**
 * Write the thinking agent's final report. On interruption (timeout/error) we
 * persist an honest stub so the main agent can integrate partial findings or
 * re-dispatch. Best-effort stream close — the report write is the truth.
 */
export async function finalizeThink(
  input: ThinkInput,
  status: "completed" | "interrupted",
  content: string,
): Promise<{ thinkId: string; status: ThinkStatus }> {
  "use step";

  const updatedAt = new Date().toISOString();
  const report: ThinkReport = {
    thinkId: input.thinkId,
    question: input.question,
    status,
    startedAt: input.startedAt,
    updatedAt,
    content: status === "completed" ? content : `**Status**: interrupted (timed out)\n\n**Partial findings**:\n\n${content || "_No output before interruption._"}`,
  };
  await writeReport(report);

  try {
    const writable = getWritable<UIMessageChunk>();
    const writer = writable.getWriter();
    await writer.write({
      type: "data-think",
      id: `think-${input.thinkId}`,
      data: {
        thinkId: input.thinkId,
        status,
        question: input.question,
      },
    } as UIMessageChunk);
    writer.releaseLock();
    await writable.close();
  } catch (err) {
    console.warn(
      `[Thinking] stream close failed (think=${input.thinkId}):`,
      err instanceof Error ? err.message : err,
    );
  }

  return { thinkId: input.thinkId, status };
}

/** Wait-loop poll: true when EVERY dispatched agent has a report file. */
export async function allReportsReady(
  thinkIds: string[],
): Promise<boolean> {
  "use step";
  for (const thinkId of thinkIds) {
    if (!(await reportExists(thinkId))) return false;
  }
  return thinkIds.length > 0;
}

/** Assemble all reports (completed + interrupted) into one integration text. */
export async function readAllReports(thinkIds: string[]): Promise<string> {
  "use step";
  const sections: string[] = [];
  for (const thinkId of thinkIds) {
    const report = await readReport(thinkId);
    const status = report?.status ?? "interrupted";
    const body = report?.content ?? "_No report available._";
    sections.push(
      [
        `### Thinking agent — ${thinkId} (${status})`,
        "",
        body,
        "",
        "---",
        "",
      ].join("\n"),
    );
  }
  return sections.join("\n");
}

/**
 * Register a dispatched thinking agent with the turn's durable state so the
 * status endpoint exposes it (TurnState.thinkingAgentIds). Best-effort.
 */
export async function registerThinkingAgent(
  turnId: string,
  thinkId: string,
): Promise<void> {
  "use step";
  try {
    const state = await readTurnState(turnId);
    if (!state) return;
    if (state.thinkingAgentIds.includes(thinkId)) return;
    await writeTurnState({
      ...state,
      thinkingAgentIds: [...state.thinkingAgentIds, thinkId],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(
      `[Thinking] failed to register think ${thinkId} with turn ${turnId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
