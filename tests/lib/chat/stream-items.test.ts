/**
 * The unified stream's item model (v0.10 §1.5): seam insertion, resume block,
 * and the exact prepend item count Virtuoso's firstItemIndex shifts by.
 */
import { describe, it, expect } from "vitest";
import {
  buildHistoryItems,
  prependPage,
  type SeamItem,
  type ResumeBannerItem,
} from "@/lib/chat/stream-items";
import type { SliceWithContent } from "@/lib/episodic/actions";
import type { Turn } from "@/lib/episodic/types";

let seq = 0;
function makeSlice(
  overrides: Partial<SliceWithContent> & { turnCount?: number } = {},
): SliceWithContent {
  seq += 1;
  const hh = String(seq).padStart(2, "0");
  const id = overrides.id ?? `2026-08-11-10${hh}`;
  const start = overrides.start ?? `2026-08-11T10:${hh}:00.000Z`;
  const turnCount = overrides.turnCount ?? 2;
  const turns: Turn[] = Array.from({ length: turnCount }, (_, i) => ({
    timestamp: `2026-08-11T10:${hh}:${String(i).padStart(2, "0")}0.000Z`,
    role: i % 2 === 0 ? "user" : "agent",
    content: `turn ${i} of ${id}`,
  }));
  return {
    id,
    start,
    focus: `focus ${id}`,
    summary: `summary ${id}`,
    tags: [],
    strands: [],
    turnCount,
    turns,
    ...overrides,
  };
}

describe("buildHistoryItems", () => {
  it("a single slice renders turns only — no seam above the head", () => {
    const items = buildHistoryItems([makeSlice()], null);
    expect(items.map((i) => i.kind)).toEqual(["history-turn", "history-turn"]);
  });

  it("inserts a seam between slices, classified by the OLDER slice's closedBy", () => {
    const older = makeSlice({ closedBy: "time_cap" });
    const newer = makeSlice();
    const items = buildHistoryItems([older, newer], null);

    const seam = items.find((i) => i.kind === "seam") as SeamItem;
    expect(seam.seam).toBe("checkpoint");
    // The boundary heading carries the NEWER slice's start.
    expect(seam.dateIso).toBe(newer.start);
    expect(seam.key).toBe(`seam-${newer.id}`);
  });

  it("classifies idle_gap / missing closedBy seams as boundaries", () => {
    const items = buildHistoryItems(
      [makeSlice({ closedBy: "idle_gap" }), makeSlice(), makeSlice()],
      null,
    );
    const seams = items.filter((i): i is SeamItem => i.kind === "seam");
    expect(seams.map((s) => s.seam)).toEqual(["boundary", "boundary"]);
  });

  it("keeps chronological order: seam, then the newer slice's turns", () => {
    const a = makeSlice({ closedBy: "capacity" });
    const b = makeSlice();
    const items = buildHistoryItems([a, b], null);
    expect(items.map((i) => i.kind)).toEqual([
      "history-turn",
      "history-turn",
      "seam",
      "history-turn",
      "history-turn",
    ]);
  });

  it("appends the resume block with a banner, and a seam when history precedes it", () => {
    const hist = makeSlice({ closedBy: "time_cap" });
    const resume = {
      sliceId: "2026-08-11-1200",
      start: "2026-08-11T12:00:00.000Z",
      focus: "f",
      turns: [
        { timestamp: "2026-08-11T12:00:00.000Z", role: "user" as const, content: "hi" },
      ],
    };
    const items = buildHistoryItems([hist], resume);
    expect(items.map((i) => i.kind)).toEqual([
      "history-turn",
      "history-turn",
      "seam",
      "resume-banner",
      "history-turn",
    ]);
    const seam = items[2] as SeamItem;
    expect(seam.seam).toBe("checkpoint");
    expect(seam.dateIso).toBe(resume.start);
    const banner = items[3] as ResumeBannerItem;
    expect(banner.startIso).toBe(resume.start);
  });

  it("resume-only (no history) renders banner + turns without a seam", () => {
    const items = buildHistoryItems([], {
      sliceId: "s1",
      start: "2026-08-11T12:00:00.000Z",
      focus: "f",
      turns: [
        { timestamp: "2026-08-11T12:00:00.000Z", role: "user", content: "hi" },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(["resume-banner", "history-turn"]);
  });
});

describe("prependPage", () => {
  it("prepends older slices and reports the exact added item count", () => {
    const existing = [makeSlice({ turnCount: 3 })];
    const page = [makeSlice({ turnCount: 2 }), makeSlice({ turnCount: 1 })];

    const { slices, addedItemCount } = prependPage(existing, page);

    expect(slices.map((s) => s.id)).toEqual([
      page[0].id,
      page[1].id,
      existing[0].id,
    ]);
    // New items: 2+1 turns + 1 seam between the two page slices + 1 NEW seam
    // between the page's last slice and the old head (the old head had none).
    expect(addedItemCount).toBe(2 + 1 + 1 + 1);
    // Sanity: the rebuilt list really grew by that much.
    expect(buildHistoryItems(slices, null).length - buildHistoryItems(existing, null).length).toBe(addedItemCount);
  });

  it("initial load onto an empty window adds turns + internal seams only", () => {
    const page = [makeSlice({ turnCount: 2 }), makeSlice({ turnCount: 2 })];
    const { addedItemCount } = prependPage([], page);
    expect(addedItemCount).toBe(4 + 1);
  });

  it("dedupes slices already in the window (overlap edge) and reports 0", () => {
    const a = makeSlice();
    const { slices, addedItemCount } = prependPage([a], [a]);
    expect(slices).toHaveLength(1);
    expect(addedItemCount).toBe(0);
  });

  it("an empty page adds nothing", () => {
    const existing = [makeSlice()];
    const { slices, addedItemCount } = prependPage(existing, []);
    expect(slices).toHaveLength(1);
    expect(addedItemCount).toBe(0);
  });
});
