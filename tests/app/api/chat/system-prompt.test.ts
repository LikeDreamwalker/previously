import { describe, it, expect } from "vitest";
import { assembleSystemPrompt } from "@/app/api/chat/turn-workflow";

const IDENTITY = "SOUL + DIRECTIVES";
const PREVIOUSLY = "# Previously card";
const STABLE_FOOTER =
  "The above is the current profile and operating model — distilled hypotheses";
const PRIMING = "## This turn — analysis";
const STRANDS = "## Memory topics\n\nKnown topics: rust";
const EVOLUTION =
  "[System] A self-evolution just completed — the previously card was updated";
const DEMO = "## Demo mode (read-only)";

type Opts = Parameters<typeof assembleSystemPrompt>[0];

function build(overrides: Partial<Opts> = {}): string {
  return assembleSystemPrompt({
    identityPrompt: IDENTITY,
    previouslyContent: PREVIOUSLY,
    turnPriming: PRIMING,
    timelineBrief: "",
    strandsBlock: STRANDS,
    evolutionNotice: EVOLUTION,
    demoNotice: DEMO,
    dateAnchor: "2026-08-09",
    ...overrides,
  });
}

describe("assembleSystemPrompt", () => {
  it("puts the STABLE blocks (identity, card, footer) before the VARIABLE tail", () => {
    const s = build();
    expect(s.indexOf(IDENTITY)).toBe(0); // identity leads the prompt
    expect(s.indexOf(PREVIOUSLY)).toBeGreaterThan(s.indexOf(IDENTITY));
    expect(s.indexOf(STABLE_FOOTER)).toBeGreaterThan(s.indexOf(PREVIOUSLY));
    // The per-turn brief starts the variable tail.
    const brief = s.indexOf(PRIMING);
    expect(brief).toBeGreaterThan(s.indexOf(STABLE_FOOTER));
    // Every variable block follows the brief.
    expect(s.indexOf(STRANDS)).toBeGreaterThan(brief);
    expect(s.indexOf(EVOLUTION)).toBeGreaterThan(brief);
    expect(s.indexOf(DEMO)).toBeGreaterThan(brief);
  });

  it("keeps the stable head byte-identical across turns with different briefs (cache prefix)", () => {
    const turnA = build({ turnPriming: "## This turn — analysis\n- Sent: 09 Aug, 10:00" });
    const turnB = build({ turnPriming: "## This turn — analysis\n- Sent: 09 Aug, 14:00" });
    const headA = turnA.slice(0, turnA.indexOf(PRIMING));
    const headB = turnB.slice(0, turnB.indexOf(PRIMING));
    expect(headA.length).toBeGreaterThan(0);
    expect(headA).toBe(headB);
  });

  it("omits empty optional blocks", () => {
    const s = build({ strandsBlock: "", evolutionNotice: "", demoNotice: "" });
    expect(s).not.toContain("Memory topics");
    expect(s).not.toContain("self-evolution");
    expect(s).not.toContain("Demo mode");
    expect(s).not.toContain("Timeline (recent)");
  });

  it("renders the timeline brief in the variable tail (after priming, before strands)", () => {
    const brief =
      "## Timeline (recent)\n- **2026-08-11-1115** 回顾滴滴时期 · 4轮";
    const s = build({ timelineBrief: brief });
    const briefIdx = s.indexOf("## Timeline (recent)");
    expect(briefIdx).toBeGreaterThan(s.indexOf(PRIMING));
    expect(briefIdx).toBeLessThan(s.indexOf(STRANDS));
    expect(s).toContain("2026-08-11-1115");
  });

  it("renders the card-freshness header with the date anchor", () => {
    expect(build()).toContain(
      "## What I know about the user (inference model — 2026-08-09)",
    );
  });
});
