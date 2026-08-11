/**
 * global-timeline accessors — v0.8: `generateGlobalTimeline` delegates to the
 * weave (timeline/index.json + timeline.md projection); `updateGlobalTimeline`
 * is a forced reconcile. The timeline FORMAT changed from a flat "## slice_id /
 * - Focus:" list to the era/day-grouped projection in `timeline/render.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory fs (same pattern as timeline/weave.test.ts) ────────────────

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

import {
  generateGlobalTimeline,
  updateGlobalTimeline,
} from "@/lib/episodic/flash/global-timeline";
import { TIMELINE_MD_PATH } from "@/lib/episodic/timeline/store";

function seedSlice(opts: { id: string; focus: string }): void {
  const [y, m, d, hm] = opts.id.split("-");
  fs.store.set(
    `memory/episodic/slices/${y}/${m}/${d}/${hm}/timeline/core.md`,
    [
      "---",
      `slice_id: ${opts.id}`,
      "status: closed",
      `start: '${y}-${m}-${d}T10:00:00.000Z'`,
      `focus: '${opts.focus}'`,
      "---",
      "",
      "## Turn t1 — 2026-08-11T10:00:00.000Z (user)",
      "",
      "hello",
    ].join("\n"),
  );
}

beforeEach(() => {
  fs.store.clear();
});

describe("generateGlobalTimeline", () => {
  it("weaves the slice tree into the era/day projection and returns it", async () => {
    seedSlice({ id: "2026-08-11-1115", focus: "滴滴反思" });

    const result = await generateGlobalTimeline();

    expect(result).toContain("# Timeline");
    expect(result).toContain("## 2026-08");
    expect(result).toContain("滴滴反思");
    // The projection is written to the legacy path the recall agent reads.
    expect(fs.store.get(TIMELINE_MD_PATH)).toBe(result);
  });

  it("returns a graceful empty projection when the tree is empty", async () => {
    const result = await generateGlobalTimeline();
    expect(result).toContain("_Slices: 0_");
  });
});

describe("updateGlobalTimeline", () => {
  it("forces a reconcile so a just-closed slice appears immediately", async () => {
    seedSlice({ id: "2026-08-11-1115", focus: "滴滴反思" });
    await generateGlobalTimeline(); // fresh catalog
    const before = fs.store.get(TIMELINE_MD_PATH)!;

    seedSlice({ id: "2026-08-11-1426", focus: "新人设" });
    await updateGlobalTimeline();

    const after = fs.store.get(TIMELINE_MD_PATH)!;
    expect(after).toContain("新人设");
    expect(after).not.toBe(before);
  });
});
