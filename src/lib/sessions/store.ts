/**
 * Turn-state persistence — the durable record of a chat turn's lifecycle.
 *
 * Layer 2 of v0.6 ("background-first turn model"): the turn becomes a resumable
 * task whose fate survives the eviction of its workflow run from memory. Two
 * small files under `memory/sessions/`:
 *
 *   memory/sessions/<turnId>.json        — the canonical TurnState (written by
 *                                          finalizeTurn when the turn settles)
 *   memory/sessions/.runs/<runId>.json   — runId → turnId mapping (written by
 *                                          the route layer, the only place that
 *                                          knows the workflow run id; the
 *                                          deterministic workflow body does not)
 *
 * A client that only holds the runId (persisted by WorkflowChatTransport) can
 * resolve turnId via the mapping, then read the state. Mirrors the loop store's
 * local-fs-vs-GitHub switch (gated on STORAGE/GITHUB_TOKEN via
 * resolveDataSource) so it behaves identically in dev and production.
 */
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import type { TurnState } from "@/lib/chat/turn-types";

const STATE_DIR = "memory/sessions";
const RUN_MAP_DIR = "memory/sessions/.runs";

function turnStatePath(turnId: string): string {
  return `${STATE_DIR}/${turnId}.json`;
}

function runMapPath(runId: string): string {
  return `${RUN_MAP_DIR}/${runId}.json`;
}

/** Write the durable turn-state record (keyed by turnId). Idempotent. */
export async function writeTurnState(state: TurnState): Promise<void> {
  const content = JSON.stringify(state, null, 2);
  if (resolveDataSource() === "github") {
    const { owner, repo } = getRepoConfig();
    await writeFileGitHub(
      turnStatePath(state.turnId),
      content,
      repo,
      owner,
      `Update turn state ${state.turnId}`,
    );
    return;
  }
  await writeFileLocal(turnStatePath(state.turnId), content);
}

/** Read the turn-state record back; null when absent or unparseable. */
export async function readTurnState(turnId: string): Promise<TurnState | null> {
  let raw: string;
  try {
    if (resolveDataSource() === "github") {
      const { owner, repo } = getRepoConfig();
      raw = await readFileGitHub(turnStatePath(turnId), repo, owner);
    } else {
      raw = await readFileLocal(turnStatePath(turnId));
    }
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(raw) as Partial<TurnState>;
    if (typeof data.turnId !== "string") return null;
    return {
      turnId: data.turnId,
      status: data.status ?? "active",
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
      partialText: typeof data.partialText === "string" ? data.partialText : "",
      thinkingAgentIds: Array.isArray(data.thinkingAgentIds)
        ? (data.thinkingAgentIds as string[])
        : [],
    };
  } catch {
    return null;
  }
}

/** Record the runId → turnId mapping (route layer; the workflow can't know its run id). */
export async function writeRunTurnMapping(
  runId: string,
  turnId: string,
): Promise<void> {
  const content = JSON.stringify({ turnId }, null, 2);
  if (resolveDataSource() === "github") {
    const { owner, repo } = getRepoConfig();
    await writeFileGitHub(
      runMapPath(runId),
      content,
      repo,
      owner,
      `Register run ${runId}`,
    );
    return;
  }
  await writeFileLocal(runMapPath(runId), content);
}

/** Resolve the turn that a workflow run belongs to; null when unregistered. */
export async function readTurnIdByRun(runId: string): Promise<string | null> {
  let raw: string;
  try {
    if (resolveDataSource() === "github") {
      const { owner, repo } = getRepoConfig();
      raw = await readFileGitHub(runMapPath(runId), repo, owner);
    } else {
      raw = await readFileLocal(runMapPath(runId));
    }
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(raw) as { turnId?: unknown };
    return typeof data.turnId === "string" ? data.turnId : null;
  } catch {
    return null;
  }
}
