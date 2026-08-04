/**
 * Thinking-agent persistence — task cards and reports under `memory/thinking/`.
 *
 * Mirrors the loop store's local-fs-vs-GitHub switch (gated on
 * STORAGE/GITHUB_TOKEN via resolveDataSource) so it behaves identically in dev
 * and production:
 *
 *   memory/thinking/<thinkId>/task.md    — the dispatch record (written by the
 *                                          thinkDeep executor before starting
 *                                          the workflow; observability/tracing)
 *   memory/thinking/<thinkId>/report.md  — the agent's final report (written by
 *                                          finalizeThink; the main agent polls
 *                                          for its existence to know when to
 *                                          integrate)
 */
import matter from "gray-matter";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import type { ThinkInput, ThinkReport, ThinkStatus } from "./types";

const THINK_DIR = "memory/thinking";

export function taskPath(thinkId: string): string {
  return `${THINK_DIR}/${thinkId}/task.md`;
}

export function reportPath(thinkId: string): string {
  return `${THINK_DIR}/${thinkId}/report.md`;
}

/** Write the dispatch record. Idempotent. */
export async function writeTaskCard(input: ThinkInput): Promise<void> {
  const content = [
    `# Thinking task — ${input.thinkId}`,
    "",
    `**Effort**: ${input.effort}`,
    input.outputFormat ? `**Format**: ${input.outputFormat}` : "",
    "",
    "## Question",
    "",
    input.question,
    "",
  ]
    .filter(Boolean)
    .join("\n");
  await writeThinkingFile(taskPath(input.thinkId), content, `Create task ${input.thinkId}`);
}

/** Serialize a report with YAML frontmatter so status is machine-readable. */
export function serializeReport(report: ThinkReport): string {
  return matter.stringify(report.content, {
    think_id: report.thinkId,
    question: report.question,
    status: report.status,
    started_at: report.startedAt,
    updated_at: report.updatedAt,
  });
}

/** Write the final report. Idempotent — safe to re-run after a retry. */
export async function writeReport(report: ThinkReport): Promise<void> {
  await writeThinkingFile(
    reportPath(report.thinkId),
    serializeReport(report),
    `Write report ${report.thinkId}`,
  );
}

/** Read a report back; null when absent or unparseable. */
export async function readReport(thinkId: string): Promise<ThinkReport | null> {
  let raw: string;
  try {
    raw = await readThinkingFile(reportPath(thinkId));
  } catch {
    return null;
  }

  try {
    const { data, content } = matter(raw);
    return {
      thinkId: typeof data.think_id === "string" ? data.think_id : thinkId,
      question: typeof data.question === "string" ? data.question : "",
      status: (data.status ?? "interrupted") as ThinkStatus,
      startedAt: typeof data.started_at === "string" ? data.started_at : "",
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : "",
      content,
    };
  } catch {
    return null;
  }
}

/** Whether a report file exists on disk (the wait-loop's done signal). */
export async function reportExists(thinkId: string): Promise<boolean> {
  return (await readReport(thinkId)) !== null;
}

async function writeThinkingFile(path: string, content: string, message: string): Promise<void> {
  if (resolveDataSource() === "github") {
    const { owner, repo } = getRepoConfig();
    await writeFileGitHub(path, content, repo, owner, message);
    return;
  }
  await writeFileLocal(path, content);
}

async function readThinkingFile(path: string): Promise<string> {
  if (resolveDataSource() === "github") {
    const { owner, repo } = getRepoConfig();
    return await readFileGitHub(path, repo, owner);
  }
  return await readFileLocal(path);
}
