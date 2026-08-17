import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEMO = join(ROOT, "memory", "demo", "personal_14", "episodic", "slices");

const fixes = {
  "2023/11/19": {
    focus: "Rediscovering old legal and civic procedurals",
    summary: "Rediscovered love for older legal and civic procedurals after a backyard movie night with Lena. Discussed how this signals widening mental space and how to sustain the interest without over-engineering leisure into another optimization project.",
    decisions: ["Declare older legal and civic procedurals an active preference, not a fluke", "Create a short mood-sorted list of procedurals to bypass decision fatigue", "Set up a home movie night and leave the door open for another neighbor outing"],
    open_loops: ["Whether this new interest will stick or become another abandoned phase", "Need to curate a list of older procedurals sorted by mood categories", "Avoid turning leisure into another solo optimization project"],
    tags: ["personal", "movies", "taste", "rediscovery", "habits", "leisure"],
    emotional_tone: "positive"
  },
  "2024/01/30": {
    focus: "Corridor scoreboard defending focused flood mitigation strategy",
    summary: "Built a corridor scoreboard by block to prove the concentrated model is converting. It defends the focused strategy from being diluted. Recognized strength for translating field mess into tools that make the work legible to leadership.",
    decisions: ["Keep scoreboard front page spare with direction markers; draft backup with definitions and caveats", "Include both strong and slower blocks to ground the story and preempt criticism", "Add intended-use sentence to scoreboard to head off feature creep from other departments"],
    open_loops: ["Whether the scoreboard should include trend lines or stay as point-in-time block counts", "How to refuse additional columns from other departments without sounding territorial", "Whether a slow month will trigger a pullback to broad county-wide outreach"],
    tags: ["work", "housing", "data-tools", "community-outreach", "strategy-defense", "conversion-metrics", "professional-growth"],
    emotional_tone: "positive"
  },
  "2024/05/05": {
    focus: "Corridor walkthrough — visible progress through resident testimony",
    summary: "Led a corridor walk with buyout homeowners speaking to newer residents. Peer testimony proved more persuasive than staff presentations. Felt genuine hope seeing outreach mature past paperwork into neighborhood trust.",
    decisions: ["Write down the corridor walk sequence while details are fresh", "Keep walks milestone-based with lighter resident quote touchpoints in between", "Send brief heads-up to leadership without overselling"],
    open_loops: ["Whether a repeatable walk format preserves authenticity or feels scripted", "How to rotate in new resident voices without exhausting early participants", "Whether written resident blurbs can capture what made live testimony persuasive"],
    tags: ["flood-mitigation", "community-outreach", "resident-testimony", "trust-building", "professional-growth", "public-engagement"],
    emotional_tone: "positive"
  },
  "2024/06/23": {
    focus: "Paper scorekeeping at an Astros game as mental reset",
    summary: "Spontaneously went to an Astros game with coworker Miguel after a late meeting. He taught simple paper scorekeeping — a structured, bounded activity that held attention and kept work thoughts away for three hours. Realized genuine rest comes from low-pressure social connection, tactile focus, and a clear endpoint.",
    decisions: ["Keep this first scorecard as a meaningful marker of a restorative evening", "Keep a simple pencil in the truck for spontaneous future games", "Go to games only when already downtown, max once or twice a season"],
    open_loops: ["Whether a second game will feel as grounding as the first", "Whether bounded activities with a built-in frame can apply to other areas beyond baseball", "Whether the pencil in the truck will actually turn into a second scorecard"],
    tags: ["personal", "rest-and-recovery", "work-life-balance", "social-connection", "baseball", "scorekeeping", "mindfulness"],
    emotional_tone: "positive"
  },
  "2024/08/31": {
    focus: "Defending concentrated outreach model against budget-driven dilution",
    summary: "Faced county budget pressure threatening to spread outreach hours thin. Using a wall map with household status dots, call-back logs, and conversion data, successfully defended the concentrated follow-through corridor model. Sharon backed the evidence, framing it as a practical staffing question. Role shift from practitioner to institutional model defender.",
    decisions: ["Lead with drop-off reduction data as primary proof, use repeatable learning lessons as second layer", "Frame the argument as conversion protection, not turf protection", "Create a one-page standing summary: conversion gained, drop-off reduced, staff touches needed"],
    open_loops: ["Whether the budget defense truly protected the corridor long-term or only bought time", "How to institutionalize the argument so evidence works even when not in the room", "Whether the role shift from practitioner to model defender is sustainable or exhausting"],
    tags: ["outreach", "community-work", "budget-defense", "program-management", "data-driven-advocacy", "role-transition"],
    emotional_tone: "mixed"
  },
  "2024/10/14": {
    focus: "Funding a home drainage overhaul — cost and professional empathy",
    summary: "Funded a substantial gutter and drainage overhaul before winter rains — a financially painful but necessary prevention decision. The experience reshaped perspective on what mitigation systems ask of people vs. what people can realistically absorb. Resolved to revise workshop notes to name real tradeoffs rather than detached engineering logic.",
    decisions: ["Choose permanent prevention spend over continued temporary repairs", "Reframe the expense as successful prevention spend and hardening the house rather than a loss", "Revise workshop notes to use grounded language that names real tradeoffs without being bitter"],
    open_loops: ["How to translate personal frustration into useful framing for workshop audiences", "Whether naming the financial weight openly helps people or discourages them"],
    tags: ["housing", "home-maintenance", "mitigation", "prevention", "personal-finance", "empathy", "workshop-redesign"],
    emotional_tone: "mixed"
  },
  "2025/01/17": {
    focus: "Building a 30/60/90 day post-approval retention system",
    summary: "Built a formal retention system for approved households — 30/60/90 day intervals with named contacts per file. Shifted from treating approval as a finish line to treating it as an active support case. Plans to present it as a practice standard via a one-pager.",
    decisions: ["Implement the 30/60/90 day interval schedule with distinct purposes per phase", "Assign one named contact per file for accountability", "Draft a one-page practice standard to socialize the system"],
    open_loops: ["Whether staff will adopt the named contact role consistently", "Whether the one-pager will actually be read and used", "Whether distinct interval purposes hold across varying household situations"],
    tags: ["work", "retention", "process-improvement", "post-approval-care", "system-design", "workflow"],
    emotional_tone: "positive"
  },
  "2025/03/09": {
    focus: "Brief weekend trip to Lafayette with Lena",
    summary: "Short weekend trip to Lafayette for a cousins gathering with Lena. Careful planning, a locked-in return date, and house-check coverage made leaving home feel manageable for the first time. Stayed present during the trip rather than mentally at home. Realized brief regional travel is workable with the right conditions.",
    decisions: ["Create a short list of 3-4 driveable weekend options for future travel", "Lock in a fixed return date before every trip", "Include a bedtime house-check confirmation as a standard travel condition"],
    open_loops: ["Whether a second short trip in the coming months will feel as manageable", "Whether the travel template generalizes beyond family-gathering purposes", "How to keep the weekend list simple enough to avoid becoming a project"],
    tags: ["travel", "anxiety-management", "planning", "marriage", "weekend-trip", "self-awareness", "personal-growth", "family"],
    emotional_tone: "positive"
  },
  "2025/05/28": {
    focus: "Presenting corridor program results to senior leadership",
    summary: "Briefed senior staff on corridor program results, arguing that reduced post-approval dropout — not larger public meetings — drove adoption gains. Used dropout-stage data, resident photos, and a marked map to reframe success from attendance to completion. Felt tired but vindicated after years of methodical work finally showed.",
    decisions: ["Draft a one-page internal note while the briefing is fresh to preserve the core operational lesson", "Make dropout-stage reduction the opening frame in future presentations rather than burying it", "Keep explanations plain and jargon-free so the insight travels beyond the briefing room"],
    open_loops: ["Whether the one-pager will effectively prevent the story from being flattened over time", "How to share credit with collaborators without diluting the core operational lesson", "What this new visibility means for career trajectory long-term"],
    tags: ["work", "presentation", "professional-growth", "program-metrics", "retention", "corridor-results", "data-storytelling"],
    emotional_tone: "mixed"
  }
};

function updateFrontmatter(raw, meta) {
  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) throw new Error("No frontmatter");
  const body = raw.slice(fmEnd + 3);
  const fm = raw.slice(3, fmEnd);

  const ex = {};
  for (const key of ["slice_id", "status", "start", "end", "timezone"]) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
    const m = fm.match(re);
    if (m) ex[key] = m[1].trim().replace(/^["']|["']$/g, "");
  }

  const lines = ["---"];
  lines.push(`slice_id: ${ex.slice_id || ""}`);
  lines.push(`focus: ${meta.focus}`);
  lines.push(`status: ${ex.status || "closed"}`);
  lines.push(`start: "${ex.start || ""}"`);
  if (ex.end) lines.push(`end: "${ex.end}"`);
  if (ex.timezone) lines.push(`timezone: ${ex.timezone}`);
  lines.push(`summary: ${meta.summary}`);

  lines.push("decisions:");
  for (const d of meta.decisions) lines.push(`  - ${d}`);
  lines.push("open_loops:");
  for (const o of meta.open_loops) lines.push(`  - ${o}`);
  lines.push("tags:");
  for (const t of meta.tags) lines.push(`  - ${t}`);
  lines.push(`emotional_tone: ${meta.emotional_tone}`);
  lines.push("---");
  return lines.join("\n") + body;
}

let count = 0;
for (const [rel, meta] of Object.entries(fixes)) {
  const fp = join(DEMO, rel + ".md");
  const raw = readFileSync(fp, "utf-8");
  const updated = updateFrontmatter(raw, meta);
  writeFileSync(fp, updated);
  count++;
  console.log(`  OK ${rel}`);
}
console.log(`Fixed ${count} files`);
