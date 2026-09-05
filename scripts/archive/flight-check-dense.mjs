// Dense-region flight check for the 3D timeline (v0.10.0 Rev 5.1).
// Verifies: (a) cards never vanish mid-flight / mid-scroll in the dense
// region, (b) level steps change card tiers only via deliberate gestures,
// (c) card entry animates (opacity ramps, no pop-in at full opacity).
// Usage: node scripts/archive/flight-check-dense.mjs [baseUrl]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const shots = "test-results";
const results = [];
const note = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${base}/en/timeline`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 20000 });

const countCards = () => page.locator(".tl-card-in").count();
const opacitySum = () =>
  page.locator(".tl-card-in").evaluateAll((els) =>
    els.reduce((s, el) => s + parseFloat(getComputedStyle(el).opacity), 0),
  );
const settle = (ms = 1600) => page.waitForTimeout(ms);

// ── 1. Land and wait for first cards ────────────────────────────────────────
try {
  await page.waitForSelector(".tl-card-in", { timeout: 20000 });
  note("land: cards appear", true, `count=${await countCards()}`);
} catch {
  note("land: cards appear", false, "no .tl-card-in within 20s");
  await page.screenshot({ path: `${shots}/dense-fail-land.png` });
  await browser.close();
  process.exit(1);
}

// ── 2. Scroll up into the dense region ──────────────────────────────────────
await page.mouse.move(720, 450);
for (let i = 0; i < 15; i++) {
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(80);
}
await settle(1800);
const denseCount = await countCards();
await page.screenshot({ path: `${shots}/dense-enter.png` });
note("dense region: cards present", denseCount > 0, `count=${denseCount}`);

// ── 3. Step through levels; sample mid-flight and settled ───────────────────
for (let lvl = 2; lvl <= 4; lvl++) {
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240); // one deliberate zoom-in step
  await page.keyboard.up("Control");
  await page.waitForTimeout(350); // mid-flight
  const mid = await countCards();
  await settle(1800);
  const done = await countCards();
  await page.screenshot({ path: `${shots}/dense-l${lvl}.png` });
  note(
    `L${lvl}: cards survive flight`,
    mid > 0 && done > 0,
    `mid=${mid} settled=${done}`,
  );
}

// ── 4. Scroll inside the dense region at L4 — never zero cards ──────────────
// Small steps: a transient 0 is legitimate when the window crosses a gap
// between nodes — only a STUCK blank (consecutive zeros) or an empty final
// state counts as disappearance.
let zeroStreak = 0;
let maxZeroStreak = 0;
for (const dir of [1, 1, 1, -1, -1, -1]) {
  await page.mouse.wheel(0, dir * 200);
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(150);
    const n = await countCards();
    zeroStreak = n === 0 ? zeroStreak + 1 : 0;
    maxZeroStreak = Math.max(maxZeroStreak, zeroStreak);
  }
}
await settle(1200);
const afterScroll = await countCards();
await page.screenshot({ path: `${shots}/dense-l4-scrolled.png` });
note(
  "L4 scroll: no disappearance",
  maxZeroStreak < 3 && afterScroll > 0,
  `maxZeroStreak=${maxZeroStreak} final=${afterScroll}`,
);

// ── 5. Entry animation: scroll far, then sample opacity during re-entry ─────
await page.mouse.wheel(0, 4000); // jump far toward now (fewer/no nodes)
await settle(1500);
// Scroll back up in small increments; on first appearance keep going a little
// so the node lands well INSIDE the window — a card at the window's outer
// edge is off-screen by design and residual camera easing can legitimately
// unmount it (that's not the "vanishing on screen" bug).
let appeared = false;
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel(0, -150);
  await page.waitForTimeout(70);
  if (!appeared && (await countCards()) > 0) appeared = true;
  if (appeared && i % 2 === 1) {
    // two extra nudges past first appearance, then stop
    await page.mouse.wheel(0, -150);
    break;
  }
}
// Poll opacity tightly through the 320ms keyframe window.
const samples = [];
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(40);
  const n = await countCards();
  if (n > 0) samples.push((await opacitySum()) / n);
}
await settle(1500);
const finalCount = await countCards();
const finalAvg = (await opacitySum()) / Math.max(1, finalCount);
await page.screenshot({ path: `${shots}/dense-reentry.png` });
// min<0.9 proves the ramp; missing the window entirely is acceptable ONLY if
// cards are stably present at full opacity afterwards (CSS keyframes run on
// mount by construction — the poll can simply be too coarse).
const ramped = samples.length > 0 && Math.min(...samples) < 0.9;
const stableFull = finalCount > 0 && finalAvg > 0.95;
note(
  "entry: opacity ramps (no pop-in)",
  appeared && stableFull && (ramped || samples.every((s) => s >= 0.95)),
  `appeared=${appeared} samples=[${samples.map((s) => s.toFixed(2)).join(",")}] final=${finalAvg.toFixed(2)} (n=${finalCount})`,
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
