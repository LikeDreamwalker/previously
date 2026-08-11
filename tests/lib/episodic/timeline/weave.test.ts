/**
 * weaveTimeline — reconciliation over an in-memory slice tree.
 *
 * Uses vi.hoisted + an in-memory Map as the io layer, so we can seed "real"
 * slice core.md files and observe what the weave adds / drops / flags.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory fs ────────────────────────────────────────────────────────

const fs = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    readFile: async (p: string) => {
      if (!store.has(p)) throw new Error(`File not found: "${p}"`);
      return store.get(p)!;
    },
    writeFile: async (p: string, c: string) => {
      store.set(p, c);
      return { path: p, created: true };
    },
    listFiles: async (p: string) => {
      const norm = p.replace(/\/$/, "");
      const prefix = norm + "/";
      const seen = new Map<string, "file" | "dir">();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (!seg) continue;
        seen.set(seg, rest === seg ? "file" : "dir");
      }
      return [...seen.entries()].map(([name, type]) => ({ name, type, path: `${norm}/${name}` }));
    },
  };
});

vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: (p: string) => fs.readFile(p),
  fsWriteFile: (p: string, c: string) => fs.writeFile(p, c),
  fsListFiles: (p: string) => fs.listFiles(p),
}));

vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: () => "local",
  isDemo: () => false,
  isWritable: () => true,
}));

import { weaveTimeline, WEAVE_FRESH_MS } from "@/lib/episodic/timeline/weave";
import { TIMELINE_INDEX_PATH, TIMELINE_MD_PATH } from "@/lib/episodic/timeline/store";
import type { TimelineIndex } from "@/lib/episodic/timeline/types";

// ─── Fixtures ────────────────────────────────────────────────────────────

/** Build a slice core.md at the right path. */
function seedSlice(opts: {
  id: string;
  focus?: string;
  summary?: string;
  tags?: string[];
  status?: string;
  start?: string;
  turns?: number;
}): void {
  const [y, m, d, hm] = opts.id.split("-");
  const rel = `${y}/${m}/${d}/${hm}`;
  const start = opts.start ?? `${y}-${m}-${d}T10:00:00.000Z`;
  const fm = [
    "---",
    `slice_id: ${opts.id}`,
    `status: ${opts.status ?? "closed"}`,
    `start: '${start}'`,
    ...(opts.focus ? [`focus: '${opts.focus}'`] : []),
    ...(opts.summary ? [`summary: '${opts.summary}'`] : []),
    ...(opts.tags?.length ? ["tags:", ...opts.tags.map((t) => `  - ${t}`)] : []),
    "---",
    "",
  ].join("\n");
  const n = opts.turns ?? 2;
  const turns = Array.from(
    { length: n },
    (_, i) =>
      `## Turn t${i} — 2026-08-11T10:0${i}:00.000Z (user)\n\nmessage ${i}`,
  ).join("\n\n");
  fs.store.set(`memory/episodic/slices/${rel}/timeline/core.md`, fm + "\n" + turns);
}

function indexAt(): TimelineIndex | null {
  const raw = fs.store.get(TIMELINE_INDEX_PATH);
  return raw ? (JSON.parse(raw) as TimelineIndex) : null;
}

beforeEach(() => {
  fs.store.clear();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("weaveTimeline — first run (no catalog yet)", () => {
  it("builds the catalog from the slice tree and flags dry slices", async () => {
    seedSlice({ id: "2026-08-11-1115", focus: "滴滴反思", summary: "回顾绩效背锅", tags: ["状态回忆"] });
    seedSlice({ id: "2026-08-11-1025", tags: ["公司注册"] }); // dry — no focus/summary
    seedSlice({ id: "2026-08-10-1839", status: "active", focus: "地址研究" });
    fs.store.set("memory/episodic/strands.json", JSON.stringify({ 公司注册: ["2026/08/11/1025"] }));

    const result = await weaveTimeline({ force: true });

    expect(result.skipped).toBe(false);
    expect(result.total).toBe(3);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
    expect(result.needs_marking).toBe(1); // only 1025 is dry

    const idx = indexAt()!;
    expect(idx.slice_count).toBe(3);
    const dry = idx.slices.find((s) => s.id === "2026-08-11-1025");
    expect(dry?.needs_marking).toBe(true);
    expect(dry?.strands).toContain("公司注册"); // woven from strands.json
    const marked = idx.slices.find((s) => s.id === "2026-08-11-1115");
    expect(marked?.needs_marking).toBe(false);
    expect(marked?.turn_count).toBe(2);

    // markdown projection written + era/day grouped
    const md = fs.store.get(TIMELINE_MD_PATH)!;
    expect(md).toContain("## 2026-08");
    expect(md).toContain("### 08-11");
    expect(md).toContain("滴滴反思");
  });

  it("does not choke on an empty tree", async () => {
    const result = await weaveTimeline({ force: true });
    expect(result.total).toBe(0);
    expect(result.needs_marking).toBe(0);
    expect(indexAt()!.slice_count).toBe(0);
  });
});

describe("weaveTimeline — reconciliation", () => {
  it("adds a slice that exists on disk but is missing from the projection", async () => {
    seedSlice({ id: "2026-08-11-1025", focus: "公司注册" });
    seedSlice({ id: "2026-08-11-1115", focus: "滴滴反思" });
    await weaveTimeline({ force: true });
    expect(indexAt()!.slice_count).toBe(2);

    // A new slice lands on disk after the catalog was built.
    seedSlice({ id: "2026-08-11-1426", focus: "新人设" });
    const result = await weaveTimeline({ force: true });

    expect(result.added).toBe(1);
    expect(result.total).toBe(3);
    expect(indexAt()!.slices.some((s) => s.id === "2026-08-11-1426")).toBe(true);
  });

  it("drops a phantom projection entry whose slice no longer exists on disk", async () => {
    seedSlice({ id: "2026-08-11-1115", focus: "滴滴反思" });
    await weaveTimeline({ force: true });

    // Manually inject a phantom entry (index says it exists, disk doesn't).
    const idx = indexAt()!;
    idx.slices.push({
      id: "2026-07-01-0000",
      date: "2026-07-01",
      start: "2026-07-01T00:00:00.000Z",
      status: "closed",
      focus: "ghost",
      summary: "",
      tags: [],
      open_loops: [],
      decisions: [],
      strands: [],
      needs_marking: false,
    });
    fs.store.set(TIMELINE_INDEX_PATH, JSON.stringify(idx));

    const result = await weaveTimeline({ force: true });

    expect(result.removed).toBe(1);
    expect(result.total).toBe(1);
    expect(indexAt()!.slices.every((s) => s.id !== "2026-07-01-0000")).toBe(true);
  });

  it("clears needs_marking once the semantic gap is filled", async () => {
    seedSlice({ id: "2026-08-11-1025", tags: ["公司注册"] });
    await weaveTimeline({ force: true });
    expect(indexAt()!.slices[0].needs_marking).toBe(true);

    // The fill worker writes focus/summary into the frontmatter.
    const [y, m, d, hm] = "2026-08-11-1025".split("-");
    const path = `memory/episodic/slices/${y}/${m}/${d}/${hm}/timeline/core.md`;
    const raw = fs.store.get(path)!;
    fs.store.set(
      path,
      raw.replace("tags:\n  - 公司注册", "focus: '公司注册地址'\nsummary: '选址与流程'\ntags:\n  - 公司注册"),
    );

    const result = await weaveTimeline({ force: true });
    expect(result.newly_dry).toBe(0);
    expect(indexAt()!.slices[0].needs_marking).toBe(false);
  });
});

describe("weaveTimeline — throttle", () => {
  it("skips the full reconcile while the catalog is fresh, unless forced", async () => {
    seedSlice({ id: "2026-08-11-1115", focus: "滴滴反思" });
    await weaveTimeline({ force: true });
    expect(indexAt()!.updated_at).toBeTruthy();

    // Fresh catalog — a non-forced weave short-circuits.
    const fresh = await weaveTimeline();
    expect(fresh.skipped).toBe(true);

    // A forced weave reconciles even when fresh.
    const forced = await weaveTimeline({ force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.total).toBe(1);
  });
});
