/**
 * Loop run persistence — serialize a LoopRun to markdown and write it to
 * `memory/loops/...` after every step.
 *
 * Mirrors the episodic subsystem's local-fs-vs-GitHub switch (gated on
 * GITHUB_TOKEN, see src/lib/episodic/manager.ts) so it behaves identically in
 * local dev (writes to disk) and production (writes to the repo).
 */
import matter from "gray-matter";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import {
  readFileLocal,
  writeFileLocal,
  listFilesLocal,
} from "@/lib/tools/local-fs";
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { getDefaultBranch } from "@/lib/tools/batch-write";
import { resolveDataSource } from "@/lib/data-source/resolve";
import {
  LOOP_ZOMBIE_MS,
  type LoopRun,
  type LoopStatus,
  type LoopStep,
} from "./types";

/**
 * Write/update the loop record file. Idempotent: writeFile resolves the
 * existing blob SHA and updates in place, so calling this after every step is
 * safe. Path validation (memory/ whitelist) happens inside the tools layer.
 */
export async function writeLoopFile(
  path: string,
  content: string
): Promise<void> {
  if (resolveDataSource() === "github") {
    const { owner, repo } = getRepoConfig();
    await writeFileGitHub(path, content, repo, owner, `Update loop ${path}`);
    return;
  }
  await writeFileLocal(path, content);
}

/**
 * Read the loop record back from storage and reconstruct the LoopRun from its
 * YAML frontmatter (which carries the full `steps` array — see serializeLoop).
 * Returns null when the file doesn't exist yet or can't be parsed; callers
 * treat that as "no steps recorded so far".
 */
export async function readLoopRun(path: string): Promise<LoopRun | null> {
  let raw: string;
  try {
    if (resolveDataSource() === "github") {
      const { owner, repo } = getRepoConfig();
      raw = await readFileGitHub(path, repo, owner);
    } else {
      raw = await readFileLocal(path);
    }
  } catch {
    return null;
  }

  try {
    const { data } = matter(raw);
    const steps: LoopStep[] = Array.isArray(data.steps)
      ? (data.steps as LoopStep[])
      : [];
    return {
      loopId: typeof data.loop_id === "string" ? data.loop_id : "",
      goal: typeof data.goal === "string" ? data.goal : "",
      status: (data.status ?? "running") as LoopStatus,
      startedAt: typeof data.started_at === "string" ? data.started_at : "",
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : "",
      ...(typeof data.deadline_at === "string" && data.deadline_at
        ? { deadlineAt: data.deadline_at }
        : {}),
      sliceOrigin:
        typeof data.slice_origin === "string" ? data.slice_origin : null,
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
      iterations: steps.length,
      maxIterations:
        typeof data.max_iterations === "number" ? data.max_iterations : 0,
      lastError: typeof data.last_error === "string" ? data.last_error : "",
      steps,
    };
  } catch {
    return null;
  }
}

// ─── Serialization ─────────────────────────────────────────────────────────

/**
 * Render a LoopRun as YAML frontmatter + a Markdown step log.
 *
 * The `steps` array is duplicated into the frontmatter (machine-readable,
 * losslessly parseable back via readLoopRun) while the body stays the
 * human-readable narrative. Loop files are small, so the duplication is cheap.
 */
export function serializeLoop(run: LoopRun): string {
  const frontmatter: Record<string, unknown> = {
    loop_id: run.loopId,
    goal: run.goal,
    status: run.status,
    started_at: run.startedAt,
    updated_at: run.updatedAt,
    ...(run.deadlineAt ? { deadline_at: run.deadlineAt } : {}),
    iterations: run.iterations,
    max_iterations: run.maxIterations,
    tags: run.tags,
    steps: run.steps,
  };
  if (run.sliceOrigin) frontmatter.slice_origin = run.sliceOrigin;
  if (run.lastError) frontmatter.last_error = run.lastError;

  const body = [
    `# Loop: ${run.goal}`,
    "",
    `**Status**: ${run.status} · **Step** ${run.iterations}/${run.maxIterations}`,
    "",
    "## Steps",
    "",
    run.steps.length === 0
      ? "_No steps yet._"
      : run.steps.map(renderStep).join("\n"),
  ].join("\n");

  return matter.stringify(body, frontmatter);
}

function renderStep(s: LoopStep): string {
  return [
    `### Step ${s.step} — ${s.time}`,
    "",
    `**Action**: ${s.action}`,
    "",
    s.result,
    "",
  ].join("\n");
}

// ─── Enumeration + zombie reaping ────────────────────────────────────────────

const LOOPS_ROOT = "memory/loops";

/**
 * List every loop record file (`memory/loops/YYYY/MM/DD/<loopId>.md`).
 * GitHub: one recursive tree call. Local: a shallow date-shaped walk.
 */
export async function listLoopFiles(): Promise<string[]> {
  if (resolveDataSource() === "github") {
    const { owner, repo } = getRepoConfig();
    const octokit = getOctokit();
    const branch = await getDefaultBranch();
    const { data: ref } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const { data: tree } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref.object.sha,
      recursive: "1",
    });
    return (tree.tree ?? [])
      .filter(
        (item) =>
          item.type === "blob" &&
          typeof item.path === "string" &&
          item.path.startsWith(`${LOOPS_ROOT}/`) &&
          item.path.endsWith(".md"),
      )
      .map((item) => item.path as string);
  }

  const out: string[] = [];
  const safeList = async (p: string) => {
    try {
      return await listFilesLocal(p);
    } catch {
      return [];
    }
  };
  const isPair = (n: string) => /^\d{2}$/.test(n);
  for (const y of await safeList(LOOPS_ROOT)) {
    if (y.type !== "dir" || !/^\d{4}$/.test(y.name)) continue;
    for (const m of await safeList(y.path)) {
      if (m.type !== "dir" || !isPair(m.name)) continue;
      for (const d of await safeList(m.path)) {
        if (d.type !== "dir" || !isPair(d.name)) continue;
        for (const f of await safeList(d.path)) {
          if (f.type === "file" && f.name.endsWith(".md")) out.push(f.path);
        }
      }
    }
  }
  return out;
}

/**
 * Reap zombie records: a loop whose run died without finalizing (platform
 * kill, exhausted redeliveries) would otherwise read as "running" forever.
 * Any record still `running` whose last update is older than LOOP_ZOMBIE_MS
 * is stamped `interrupted`. Returns the reaped loop ids. Best-effort — the
 * caller (initLoop) treats a reaper failure as non-fatal.
 */
export async function reapZombieLoops(currentLoopId: string): Promise<string[]> {
  const reaped: string[] = [];
  const now = Date.now();
  for (const path of await listLoopFiles()) {
    const run = await readLoopRun(path);
    if (!run || run.status !== "running" || run.loopId === currentLoopId) {
      continue;
    }
    const lastUpdate = Date.parse(run.updatedAt || run.startedAt);
    if (Number.isNaN(lastUpdate) || now - lastUpdate < LOOP_ZOMBIE_MS) {
      continue;
    }
    await writeLoopFile(
      path,
      serializeLoop({
        ...run,
        status: "interrupted",
        lastError:
          run.lastError ||
          "The loop run stopped without a final status (interrupted by a deploy or platform kill) and was reaped after going stale.",
      }),
    );
    reaped.push(run.loopId);
  }
  return reaped;
}
