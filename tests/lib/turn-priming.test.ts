import { describe, it, expect } from "vitest";
import {
  formatLocalTime,
  classifyContinuity,
  formatGap,
  matchStrands,
  resolveSuggestedStrands,
  buildTurnPriming,
  CONTINUITY_WINDOW_MS,
  type PrevSliceRef,
  type ContinuityInfo,
  type StrandIndex,
  type EmotionalSignal,
} from "@/lib/turn-priming";

const NOW = "2026-08-02T06:32:00.000Z";

function prev(overrides: Partial<PrevSliceRef> = {}): PrevSliceRef {
  return {
    id: "2026-08-02-0530",
    focus: "Rust loop tests",
    start: "2026-08-02T05:00:00.000Z",
    end: "2026-08-02T05:30:00.000Z",
    ...overrides,
  };
}

// ─── formatLocalTime ──────────────────────────────────────────────────────

describe("formatLocalTime", () => {
  it("formats local time + UTC offset in the client's timezone", () => {
    const t = formatLocalTime(NOW, "Asia/Shanghai");
    expect(t.local).toBe("02 Aug 2026, 14:32"); // 06:32 UTC + 8h
    expect(t.zone).toBe("Asia/Shanghai");
    expect(t.offset).toMatch(/^UTC/); // "UTC+8" (Node full-icu) — allow any UTC offset string
    expect(t.utc).toBe("2026-08-02T06:32:00.000Z");
  });

  it("falls back to UTC for an invalid timezone instead of throwing", () => {
    const t = formatLocalTime(NOW, "Not/AZone");
    expect(t.zone).toBe("UTC");
    expect(t.local).toBe(t.utc);
  });

  it("treats an empty timezone as UTC", () => {
    const t = formatLocalTime(NOW, "");
    expect(t.zone).toBe("UTC");
  });
});

// ─── classifyContinuity ───────────────────────────────────────────────────

describe("classifyContinuity", () => {
  it("marks a continued active slice as continuing regardless of prevSlice", () => {
    const c = classifyContinuity(NOW, prev(), true);
    expect(c.tier).toBe("continuing");
  });

  it("classifies a close within the window as a recent return", () => {
    const c = classifyContinuity(NOW, prev(), false);
    expect(c.tier).toBe("recent_return");
    expect(c.gapMs).toBe(3_720_000); // end 05:30 → now 06:32 (1h02m)
  });

  it("classifies a close beyond the window as cold", () => {
    const c = classifyContinuity(NOW, prev({ start: "2026-07-20T00:00:00.000Z", end: "2026-07-20T01:00:00.000Z" }), false);
    expect(c.tier).toBe("cold");
    expect(c.gapMs).toBeGreaterThanOrEqual(CONTINUITY_WINDOW_MS);
  });

  it("returns none when there is no previous slice", () => {
    const c = classifyContinuity(NOW, null, false);
    expect(c.tier).toBe("none");
  });

  it("falls back to `start` when the previous slice has no end", () => {
    const c = classifyContinuity(NOW, prev({ end: undefined }), false);
    expect(c.gapMs).toBe(5_520_000); // start 05:00 → now 06:32
    expect(c.tier).toBe("recent_return");
  });
});

// ─── formatGap ────────────────────────────────────────────────────────────

describe("formatGap", () => {
  it("formats minutes", () => expect(formatGap(5 * 60_000)).toBe("5 mins ago"));
  it("formats hours", () => expect(formatGap(90 * 60_000)).toBe("2 hours ago"));
  it("formats days", () => expect(formatGap(2 * 86_400_000)).toBe("2 days ago"));
});

// ─── matchStrands ─────────────────────────────────────────────────────────

describe("matchStrands", () => {
  const strands: StrandIndex = {
    rust: ["2026/07/24/1500", "2026/06/22/1400"],
    trust: ["2026/07/01/1000"],
    "loop-testing": ["2026/07/30/1000"],
    test: ["2026/07/10/1000"], // stopword — never matches
    循环: ["2026/07/28/0900"],
    当前: ["2026/08/02/1400"], // only points at the excluded current slice
  };

  it("matches Latin tags on word boundaries (rust, not trust)", () => {
    const hits = matchStrands("I wrote some rust code", strands, {
      excludeSliceId: "2026-08-02-1400",
      nowIso: NOW,
    });
    const tags = hits.map((h) => h.tag);
    expect(tags).toContain("rust");
    expect(tags).not.toContain("trust");
  });

  it("matches CJK tags by substring", () => {
    const hits = matchStrands("这个循环有问题", strands, {
      excludeSliceId: "2026-08-02-1400",
      nowIso: NOW,
    });
    expect(hits.map((h) => h.tag)).toContain("循环");
  });

  it("skips stopwords", () => {
    const hits = matchStrands("run a test please", strands, {
      excludeSliceId: "2026-08-02-1400",
      nowIso: NOW,
    });
    expect(hits.map((h) => h.tag)).not.toContain("test");
  });

  it("drops strands that only point at the current slice", () => {
    const hits = matchStrands("当前 things here", strands, {
      excludeSliceId: "2026-08-02-1400",
      nowIso: NOW,
    });
    expect(hits.map((h) => h.tag)).not.toContain("当前");
  });

  it("ranks more recent strands higher and caps at 3", () => {
    const many: StrandIndex = {
      a: ["2026/07/30/1000"],
      b: ["2026/07/29/1000"],
      c: ["2026/07/28/1000"],
      d: ["2026/07/01/1000"],
    };
    const hits = matchStrands("a b c d", many, {
      excludeSliceId: "x",
      nowIso: NOW,
    });
    expect(hits).toHaveLength(3);
    // Most recent strand sorts first.
    expect(hits[0].tag).toBe("a");
  });

  it("returns [] for a message matching nothing", () => {
    expect(
      matchStrands("completely unrelated words", strands, {
        excludeSliceId: "2026-08-02-1400",
        nowIso: NOW,
      }),
    ).toEqual([]);
  });
});

// ─── resolveSuggestedStrands ──────────────────────────────────────────────

describe("resolveSuggestedStrands", () => {
  const strands: StrandIndex = {
    rust: ["2026/06/22/1400", "2026/07/24/1500"],
    ghost: ["2026/01/01/1000"],
    当前: ["2026/08/02/1400"],
  };

  it("maps LLM-suggested names to slice paths, dropping unknowns and the current slice", () => {
    const hits = resolveSuggestedStrands(
      ["rust", "ghost", "当前", "missing", "rust"],
      strands,
      "2026-08-02-1400",
    );
    expect(hits.map((h) => h.tag)).toEqual(["rust", "ghost"]);
    // Newest-first slice ordering; the current-slice-only strand is dropped.
    expect(hits[0].slices).toEqual(["2026/07/24/1500", "2026/06/22/1400"]);
  });

  it("returns [] when nothing resolves", () => {
    expect(resolveSuggestedStrands(["missing"], strands, "x")).toEqual([]);
  });
});

// ─── buildTurnPriming ─────────────────────────────────────────────────────

describe("buildTurnPriming", () => {
  function makeInput(
    continuity: ContinuityInfo,
    message: string,
    strands: StrandIndex = { rust: ["2026/07/24/1500"] },
    semanticHint?: { strands: string[]; reason: string },
    intent?: { type: string; reason: string },
    emotionalSignal?: EmotionalSignal,
  ) {
    return {
      message,
      clientTimezone: "Asia/Shanghai",
      nowIso: NOW,
      continuity,
      strands,
      excludeSliceId: "2026-08-02-1400",
      semanticHint,
      intent,
      emotionalSignal,
    };
  }

  it("lays out time, then continuity, then semantic links (recent return)", () => {
    const block = buildTurnPriming(
      makeInput({ tier: "recent_return", gapMs: 3_600_000, prevSlice: prev() }, "rust loop-testing again", {
        rust: ["2026/07/24/1500"],
        "loop-testing": ["2026/07/30/1000"],
      }),
    );
    expect(block).toContain("## This turn");
    expect(block).toContain("Asia/Shanghai");
    expect(block).toContain('The user\'s last session ended 1 hour ago (slice 2026-08-02-0530, "Rust loop tests")');
    expect(block).toContain("Recall that slice FIRST");
    // Semantic links come after continuity and are conditional.
    expect(block.indexOf("Continuity:")).toBeLessThan(block.indexOf("Semantic links"));
    expect(block).toContain("only if actually relevant");
  });

  it("emits the continuing-session stance", () => {
    const block = buildTurnPriming(makeInput({ tier: "continuing" }, "more on that"));
    expect(block).toContain("mid-conversation");
    expect(block).toContain("no recall needed");
  });

  it("emits the cold-start stance with orientation", () => {
    const block = buildTurnPriming(
      makeInput({ tier: "cold", gapMs: 5 * 86_400_000, prevSlice: prev({ start: "2026-07-28T00:00:00.000Z" }) }, "hello again"),
    );
    expect(block).toContain("The user's last session was 5 days ago");
    expect(block).toContain("start fresh");
  });

  it("emits the first-contact stance and omits the semantic section", () => {
    const block = buildTurnPriming(makeInput({ tier: "none" }, "hello", {}));
    expect(block).toContain("No past conversation yet.");
    expect(block).not.toContain("Semantic links");
  });

  it("builds the semantic section from the LLM hint (name → slices via index) with its reason", () => {
    const block = buildTurnPriming(
      makeInput(
        { tier: "recent_return", gapMs: 3_600_000, prevSlice: prev() },
        "rust thing",
        { rust: ["2026/07/24/1500"], other: ["2026/01/01/1000"] },
        { strands: ["rust"], reason: "mentions borrow-checker" },
      ),
    );
    expect(block).toContain("- rust (last seen Jul 24) → 2026/07/24/1500");
    expect(block).toContain("mentions borrow-checker");
    expect(block).not.toContain("other");
  });

  it("emits the LLM intent line when provided", () => {
    const block = buildTurnPriming(
      makeInput(
        { tier: "continuing" },
        "my code broke",
        {},
        undefined,
        { type: "code_debug", reason: "user is debugging" },
      ),
    );
    expect(block).toContain("- Intent: code_debug — user is debugging.");
  });

  it("omits the intent line when no intent is present", () => {
    const block = buildTurnPriming(makeInput({ tier: "continuing" }, "帮我看看这个报错"));
    expect(block).not.toContain("Intent:");
  });

  it("emits the emotional register with support-first guidance for a strong signal", () => {
    const block = buildTurnPriming(
      makeInput(
        { tier: "continuing" },
        "今天真的太累了",
        {},
        undefined,
        undefined,
        { intensity: "strong", register: "emotional", note: "user is exhausted and venting" },
      ),
    );
    expect(block).toContain(
      "- Emotional register: strong · register: emotional — user is exhausted and venting.",
    );
    expect(block).toContain("lead with acknowledgment and empathy before any analysis");
    expect(block).toContain("never read as fault-finding");
  });

  it("tells the agent to respond in kind for a playful register", () => {
    const block = buildTurnPriming(
      makeInput(
        { tier: "continuing" },
        "你又被我坑了吧哈哈",
        {},
        undefined,
        undefined,
        { intensity: "light", register: "humorous", note: "" },
      ),
    );
    expect(block).toContain("- Emotional register: light · register: humorous.");
    expect(block).toContain("respond in kind");
  });

  it("omits the emotional block for a neutral signal", () => {
    const block = buildTurnPriming(
      makeInput(
        { tier: "continuing" },
        "帮我看看这个报错",
        {},
        undefined,
        undefined,
        { intensity: "none", register: "neutral", note: "" },
      ),
    );
    expect(block).not.toContain("Emotional register");
  });

  // ── Date anchors (T3) ────────────────────────────────────────────────
  // NOW = 2026-08-02 06:32 UTC = 14:32 in Asia/Shanghai — a Sunday.

  it("injects the precomputed date-anchor table (en by default)", () => {
    const block = buildTurnPriming(makeInput({ tier: "continuing" }, "hi", {}));
    expect(block).toContain("Date anchors");
    expect(block).toContain("Today: 2026-08-02 (Sun)");
    expect(block).toContain("This week's Monday: 2026-07-27");
    expect(block).toContain("Last week: 2026-07-20 (Mon) → 2026-07-26 (Sun)");
    expect(block).toContain("Tomorrow: 2026-08-03 (Mon)");
    expect(block).toContain("This weekend: 2026-08-01 (Sat) → 2026-08-02 (Sun)");
  });

  it("renders the anchor table in zh when locale is zh", () => {
    const block = buildTurnPriming({
      ...makeInput({ tier: "continuing" }, "hi", {}),
      locale: "zh",
    });
    expect(block).toContain("日期锚点");
    expect(block).toContain("今天：2026-08-02（周日）");
    expect(block).toContain("上周：2026-07-20（周一） 至 2026-07-26（周日）");
  });

  // ── Overdue Horizon (T3) ─────────────────────────────────────────────

  it("surfaces overdue Horizon items with a proactive-ask instruction", () => {
    const block = buildTurnPriming({
      ...makeInput({ tier: "continuing" }, "hi", {}),
      overdueHorizon: [
        { text: "Ship the release", by: "2026-07-31", refs: [] },
        { text: "Renew the domain", by: "2026-07-20", refs: [] },
      ],
    });
    expect(block).toContain("Overdue commitments");
    expect(block).toContain('"Ship the release" (by 2026-07-31, 2 days overdue)');
    expect(block).toContain('"Renew the domain" (by 2026-07-20, 13 days overdue)');
    expect(block).toContain("proactively ask the user");
  });

  it("renders the overdue line in zh", () => {
    const block = buildTurnPriming({
      ...makeInput({ tier: "continuing" }, "hi", {}),
      locale: "zh",
      overdueHorizon: [{ text: "发布新版本", by: "2026-07-31", refs: [] }],
    });
    expect(block).toContain("逾期承诺");
    expect(block).toContain("「发布新版本」（by 2026-07-31，已逾期 2 天）");
  });

  it("omits the overdue line when there are no overdue items", () => {
    const block = buildTurnPriming(makeInput({ tier: "continuing" }, "hi", {}));
    expect(block).not.toContain("Overdue");
    expect(block).not.toContain("逾期");
  });
});
