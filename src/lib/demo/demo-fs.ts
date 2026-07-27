/**
 * Demo filesystem — reads benchmark persona data. Supports two backends:
 *
 *   Remote (BENCHMARK_BASE_URL set):
 *     Fetches from a public GitHub repo via raw.githubusercontent.com.
 *     No token required. Writes are NO-OP.
 *
 *   Local (BENCHMARK_BASE_URL not set, e.g. dev):
 *     Reads from a local benchmark-data repo on disk.
 *     Path: ../benchmark-data/{persona}/{relative}
 *
 * The module is only called when the data-source resolver returns "demo".
 * It never checks DEMO_MODE — the caller (data-source/resolve.ts) owns that
 * decision.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { cookies } from "next/headers";

const BENCHMARK_BASE = process.env.BENCHMARK_BASE_URL ?? "";
const IS_REMOTE = !!BENCHMARK_BASE;

// Local fallback: look for benchmark-data as a sibling of the project root
const LOCAL_DATA_DIR = join(process.cwd(), "..", "benchmark-data");

const DEFAULT_PERSONA = "personal_14";
const PERSONA_COOKIE = "demo-persona";

/**
 * Resolve the current persona from a cookie.
 *
 * In serverless deployments, module-level state does NOT survive across
 * requests. The page SSR sets a cookie (page.tsx); server actions and API
 * routes read it back here so persona always matches what the user picked.
 *
 * Falls back to the default when called outside a request context (build
 * time) or when the cookie is absent (first visit, no persona selected).
 */
async function getCurrentPersona(): Promise<string> {
  try {
    const store = await cookies();
    const value = store.get(PERSONA_COOKIE)?.value;
    if (value && /^personal_\d{2}$/.test(value)) {
      return value;
    }
  } catch {
    // cookies() throws outside of a request context (build, CLI, etc.)
  }
  return DEFAULT_PERSONA;
}

export function setDemoPersona(personaId: string) {
  // Set cookie for subsequent requests (server actions, API routes).
  // Only effective when called from a Server Component or Route Handler.
  // The `await cookies()` is fire-and-forget here since we can't block
  // in a synchronous export — but the cookie is also set by the page SSR.
  const p = cookies().then((store) => {
    store.set(PERSONA_COOKIE, personaId, {
      path: "/",
      maxAge: 60 * 60 * 24, // 1 day
      sameSite: "lax",
    });
  }).catch(() => { /* not a request context */ });
  // Prevent unhandled rejection warning
  p.catch(() => {});
}

export function getDemoPersona(): string {
  // Synchronous best-effort: for SSR rendering this is fine (cookie was
  // just set by setDemoPersona in the same request). Server actions should
  // use getCurrentPersona() directly for async cookie access.
  return DEFAULT_PERSONA;
}

// ─── Path helpers ────────────────────────────────────────────────────────

/** Strip `memory/` prefix, prepend persona dir. */
async function resolveRelative(path: string): Promise<string> {
  const relative = path.replace(/^memory\//, "");
  const persona = await getCurrentPersona();
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

export async function readFileDemo(path: string): Promise<string> {
  const rel = await resolveRelative(path);

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
  path: string
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>> {
  if (IS_REMOTE) {
    const pId = await getCurrentPersona();
    const manifest = await fetchManifest();
    const persona = manifest.personas[pId];
    if (!persona?.tree) throw new Error(`Persona "${pId}" not found in manifest`);

    const relative = path.replace(/^memory\//, "").replace(/\/$/, "");
    const segments = relative.split("/").filter(Boolean);
    let node: unknown = persona.tree;
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
  const rel = await resolveRelative(path);
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
