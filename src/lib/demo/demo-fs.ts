/**
 * Demo filesystem — reads benchmark persona data. Supports two backends:
 *
 *   Remote (BENCHMARK_BASE_URL set):
 *     Fetches from a public GitHub repo via raw.githubusercontent.com.
 *     No token required. Writes are NO-OP.
 *
 *   Local (BENCHMARK_BASE_URL not set, e.g. dev):
 *     Reads from a local clone of the `you` dataset repo on disk.
 *     Path: ../you/{persona}/{relative}
 *
 * The module is only called when the data-source resolver returns "demo".
 * It never checks DEMO_MODE — the caller (data-source/resolve.ts) owns that
 * decision.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const BENCHMARK_BASE = process.env.BENCHMARK_BASE_URL ?? "";
const IS_REMOTE = !!BENCHMARK_BASE;

// Local fallback: look for the `you` dataset repo as a sibling of the project root
const LOCAL_DATA_DIR = join(process.cwd(), "..", "you");

const DEFAULT_PERSONA = "user";

/** Currently selected persona id — set by the page from URL searchParams. */
let currentPersona = DEFAULT_PERSONA;

export function setDemoPersona(personaId: string) {
  currentPersona = personaId;
}

export function getDemoPersona(): string {
  return currentPersona;
}

// ─── Path helpers ────────────────────────────────────────────────────────

/** Strip `memory/` prefix, prepend persona dir. */
function resolveRelative(path: string, persona: string): string {
  const relative = path.replace(/^memory\//, "");
  return `${persona}/${relative}`;
}

// ─── Manifest ────────────────────────────────────────────────────────────

interface ManifestPersona {
  name: string;
  description: string;
  blurb?: string;
  topics: string[];
  sliceCount: number;
  dateRange: string[];
  tree: Record<string, unknown>;
}

interface Manifest {
  version: number;
  personas: Record<string, ManifestPersona>;
}

let manifestPromise: Promise<Manifest> | null = null;
let manifestTtl = 0;

async function fetchManifest(): Promise<Manifest> {
  const now = Date.now();
  if (manifestPromise && now < manifestTtl) return manifestPromise;
  manifestTtl = now + 3_600_000; // 1 hour

  if (IS_REMOTE) {
    manifestPromise = fetch(`${BENCHMARK_BASE}/manifest.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
        return res.json() as Promise<Manifest>;
      })
      .catch((err) => { manifestPromise = null; manifestTtl = 0; throw err; });
  } else {
    manifestPromise = Promise.resolve(
      JSON.parse(readFileSync(join(LOCAL_DATA_DIR, "manifest.json"), "utf-8"))
    ).catch((err) => { manifestPromise = null; manifestTtl = 0; throw err; });
  }

  return manifestPromise;
}

// ─── File API ────────────────────────────────────────────────────────────

/**
 * Read a file from the demo dataset. Uses `currentPersona` (set by
 * setDemoPersona during SSR) as the default, but callers can override
 * via the `persona` parameter (e.g. server actions receiving the persona
 * from the client via searchParams).
 */
export async function readFileDemo(
  path: string,
  persona?: string,
): Promise<string> {
  const rel = resolveRelative(path, persona ?? currentPersona);

  if (IS_REMOTE) {
    const res = await fetch(`${BENCHMARK_BASE}/${rel}`);
    if (!res.ok) {
      if (res.status === 404) throw new Error(`File not found: "${path}"`);
      throw new Error(`Failed to read "${path}": HTTP ${res.status}`);
    }
    return res.text();
  }

  // Local disk
  const fullPath = join(LOCAL_DATA_DIR, rel);
  if (!existsSync(fullPath)) throw new Error(`File not found: "${path}"`);
  return readFileSync(fullPath, "utf-8");
}

export async function listFilesDemo(
  path: string,
  persona?: string,
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  const pId = persona ?? currentPersona;

  if (IS_REMOTE) {
    const manifest = await fetchManifest();
    const personaEntry = manifest.personas[pId];
    if (!personaEntry?.tree) throw new Error(`Persona "${pId}" not found in manifest`);

    const relative = path.replace(/^memory\//, "").replace(/\/$/, "");
    const segments = relative.split("/").filter(Boolean);
    let node: unknown = personaEntry.tree;
    for (const seg of segments) {
      if (node && typeof node === "object" && seg in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[seg];
      } else {
        return [];
      }
    }

    const entries: Array<{ name: string; type: "file" | "dir"; path: string }> = [];
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (key === "_files" && Array.isArray(value)) {
          for (const f of value as string[]) entries.push({ name: f, type: "file", path: `${path}/${f}` });
        } else if (typeof value === "object" && value !== null) {
          entries.push({ name: key, type: "dir", path: `${path}/${key}` });
        }
      }
    }
    return entries;
  }

  // Local disk
  const rel = resolveRelative(path, pId);
  const fullPath = join(LOCAL_DATA_DIR, rel);
  if (!existsSync(fullPath)) return [];
  const stat = statSync(fullPath);
  if (stat.isFile()) return [{ name: path.split("/").pop() ?? path, type: "file", path }];

  return readdirSync(fullPath).map((name) => {
    const ep = join(fullPath, name);
    const es = statSync(ep);
    return { name, type: es.isDirectory() ? "dir" as const : "file" as const, path: `${path}/${name}` };
  });
}

export async function writeFileDemo(
  path: string,
  _content: string
): Promise<{ path: string; created: boolean }> {
  return { path, created: false };
}

// ─── Persona listing ─────────────────────────────────────────────────────

export async function listDemoPersonas(): Promise<(ManifestPersona & { id: string })[]> {
  const manifest = await fetchManifest();
  return Object.entries(manifest.personas).map(([id, p]) => ({
    id,
    name: p.name,
    description: p.description,
    blurb: p.blurb,
    topics: p.topics,
    sliceCount: p.sliceCount,
    dateRange: p.dateRange,
    tree: p.tree,
  }));
}
