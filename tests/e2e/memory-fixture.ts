/**
 * Memory-data fixture for the v0.10 memory-viz e2e specs — writes time-slice
 * files and the timeline catalog straight into the isolated MEMORY_ROOT (the
 * same dirs the webServer env got, see env.ts). Mirrors the on-disk contract:
 *
 *   memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md  (slice file)
 *   memory/episodic/timeline/index.json                      (catalog)
 *
 * Only ever touches the `episodic/` subtree — `user/config.json` (seeded by
 * prepare-env.mjs, shared with the other specs) stays put.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { E2E_MEMORY_ROOT } from "./env";

export interface FixtureTurn {
  role: "user" | "agent";
  content: string;
  /** UTC ISO 8601 timestamp. */
  at: string;
  turnId?: string;
}

export interface FixtureSlice {
  /** Slice id YYYY-MM-DD-HHMM — encodes the UTC start (drives the file path). */
  id: string;
  /** UTC ISO 8601 start (must match the id's date+time). */
  start: string;
  end?: string;
  status?: "active" | "closed";
  focus?: string;
  summary?: string;
  tags?: string[];
  strands?: string[];
  continuesFrom?: string;
  /** time_cap | capacity | idle_gap | context_lost | user_explicit */
  closedBy?: string;
  turns: FixtureTurn[];
}

/** Paranoia guard, same discipline as prepare-env.mjs. */
function episodicRoot(): string {
  if (!E2E_MEMORY_ROOT.includes("previously-e2e")) {
    throw new Error(`memory-fixture: refusing unexpected path: ${E2E_MEMORY_ROOT}`);
  }
  return path.join(E2E_MEMORY_ROOT, "episodic");
}

/** Derive the slice id (YYYY-MM-DD-HHMM, UTC) from an ISO start time. */
export function sliceIdFromStart(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function sliceFileDir(id: string): string {
  const [y, m, d, hm] = id.split("-");
  return path.join(episodicRoot(), "slices", y, m, d, hm, "timeline");
}

/** JSON.stringify produces valid YAML double-quoted strings / flow arrays. */
function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

function yamlArray(arr: string[]): string {
  return JSON.stringify(arr);
}

function serializeSlice(slice: FixtureSlice): string {
  const fm: string[] = [
    `slice_id: ${yamlScalar(slice.id)}`,
    `focus: ${yamlScalar(slice.focus ?? "")}`,
    `status: ${slice.status ?? "closed"}`,
    `start: ${yamlScalar(slice.start)}`,
  ];
  if (slice.end) fm.push(`end: ${yamlScalar(slice.end)}`);
  fm.push(
    `timezone: "UTC"`,
    `summary: ${yamlScalar(slice.summary ?? "")}`,
    `open_loops: ${yamlArray([])}`,
    `decisions: ${yamlArray([])}`,
    `tags: ${yamlArray(slice.tags ?? [])}`,
    `related_slices: []`,
    `loops: []`,
  );
  if (slice.continuesFrom) fm.push(`continues_from: ${yamlScalar(slice.continuesFrom)}`);
  if (slice.closedBy) fm.push(`closed_by: ${slice.closedBy}`);

  const body = slice.turns
    .map(
      (t, i) =>
        `## Turn ${t.turnId ?? `ft${i}`} — ${t.at} (${t.role})\n\n${t.content}`,
    )
    .join("\n\n");

  return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
}

/**
 * Write the slice files + the canonical timeline catalog (oldest → newest,
 * the weave's own ordering) into the isolated MEMORY_ROOT. The catalog is the
 * sole data source for the stream paging / search / timeline views, so both
 * must be written together — there is no housekeeping run in e2e to rebuild it.
 */
export async function seedSlices(slices: FixtureSlice[]): Promise<void> {
  const sorted = [...slices].sort((a, b) => a.id.localeCompare(b.id));
  for (const slice of sorted) {
    const dir = sliceFileDir(slice.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "core.md"), serializeSlice(slice), "utf8");
  }

  const catalog = {
    _schema: 1,
    updated_at: new Date().toISOString(),
    slice_count: sorted.length,
    needs_marking: 0,
    slices: sorted.map((s) => ({
      id: s.id,
      date: s.id.slice(0, 10),
      start: s.start,
      ...(s.end ? { end: s.end } : {}),
      turn_count: s.turns.length,
      status: s.status ?? "closed",
      focus: s.focus ?? "",
      summary: s.summary ?? "",
      tags: s.tags ?? [],
      open_loops: [],
      decisions: [],
      strands: s.strands ?? [],
      needs_marking: false,
      ...(s.continuesFrom ? { continues_from: s.continuesFrom } : {}),
      ...(s.closedBy ? { closed_by: s.closedBy } : {}),
    })),
  };
  const timelineDir = path.join(episodicRoot(), "timeline");
  await mkdir(timelineDir, { recursive: true });
  await writeFile(
    path.join(timelineDir, "index.json"),
    JSON.stringify(catalog, null, 2),
    "utf8",
  );
}

/** Remove the seeded `episodic/` subtree (per-test isolation). */
export async function clearEpisodic(): Promise<void> {
  await rm(episodicRoot(), { recursive: true, force: true });
}

/** A two-turn (user + agent) slice at a given UTC start, with sentinel
 *  content so specs can assert on exact text. */
export function makeSlice(
  startIso: string,
  opts: Partial<FixtureSlice> & { tag?: string } = {},
): FixtureSlice {
  const id = sliceIdFromStart(startIso);
  const start = new Date(startIso).getTime();
  const endIso = new Date(start + 20 * 60_000).toISOString();
  const tag = opts.tag ?? id;
  return {
    id,
    start: startIso,
    end: endIso,
    status: "closed",
    focus: opts.focus ?? `Focus of ${tag}`,
    summary: opts.summary ?? `Summary of ${tag}`,
    tags: opts.tags ?? [],
    strands: opts.strands ?? [],
    continuesFrom: opts.continuesFrom,
    closedBy: opts.closedBy ?? "idle_gap",
    turns: [
      { role: "user", content: `TURN ${tag} user question`, at: startIso },
      {
        role: "agent",
        content: `TURN ${tag} agent answer`,
        at: new Date(start + 60_000).toISOString(),
      },
    ],
  };
}
