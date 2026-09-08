/**
 * Rev 10 stage check — capture the card-field timeline at L1 (landing),
 * L0 (after clicking a stack), L2 (after ctrl+wheel zoom-out), an upward
 * scroll (pagination + threadline glow), and the strand filter.
 *
 * Gestures are synthetic events dispatched on [data-card-field].
 * Usage: node scripts/archive/rev10-shots.mjs  (SCREENSHOT_THEME=dark, SCREENSHOT_MOBILE=1)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const THEME = process.env.SCREENSHOT_THEME === "dark" ? "dark" : "light";
const MOBILE = process.env.SCREENSHOT_MOBILE === "1";
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: MOBILE
    ? { width: 390, height: 844 }
    : { width: 1600, height: 950 },
  deviceScaleFactor: MOBILE ? 2 : 1.5,
  isMobile: MOBILE,
  hasTouch: MOBILE,
  colorScheme: THEME,
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "load" });
// First paint can be slow in dev (strand list action occasionally takes 10-20s
// on a cold compile) — wait for real cards instead of a fixed sleep.
await page
  .waitForSelector(".tl-card-in", { timeout: 240000 })
  .catch(() => console.log("WARN: no cards after 240s"));
await page.waitForTimeout(2500);

const shot = (name) =>
  page.screenshot({
    path: `shots/rev10-${THEME}${MOBILE ? "-mobile" : ""}-${name}.png`,
  });

/** Fire one level step via synthetic ctrl+wheel on the card field. */
async function zoomStep(deltaY) {
  await page.evaluate((dy) => {
    const el = document.querySelector("[data-card-field]") ?? document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: dy,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, deltaY);
  await page.waitForTimeout(1100);
}

/** Plain scroll (through time) via synthetic wheel. */
async function scrollStep(deltaY) {
  await page.evaluate((dy) => {
    const el = document.querySelector("[data-card-field]") ?? document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }),
    );
  }, deltaY);
  await page.waitForTimeout(500);
}

async function census(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    return {
      cards: cards.length,
      sample: cards
        .slice(0, 3)
        .map((c) => c.getAttribute("aria-label") ?? "?"),
    };
  });
  console.log(tag, JSON.stringify(info));
}

/** Wait until the field shows real bubble text (content fetched) and the
 *  Next dev compile indicator is gone — screenshots mid-compile/mid-fetch
 *  are garbage. */
async function settle(extraMs = 900) {
  await page
    .waitForFunction(
      () =>
        !document.body.innerText.includes("Rendering…") &&
        !document.body.innerText.includes("Rendering...") &&
        [...document.querySelectorAll(".tl-card-in .line-clamp-3")].some(
          (el) => el.textContent.trim().length > 0,
        ),
      { timeout: 60000 },
    )
    .catch(() => console.log("WARN: settle timed out"));
  await page.waitForTimeout(extraMs);
}

await census("landed");
await settle();
await shot("l1-landing");

// Click the most-fully-visible stack → L0 anchored on that day.
const stackIndex = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".tl-card-in")];
  let best = 0;
  let bestScore = -1;
  const vh = window.innerHeight;
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (visible > bestScore) {
      bestScore = visible;
      best = i;
    }
  });
  return best;
});
const stack = page.locator(".tl-card-in").nth(stackIndex);
await stack.click({ position: { x: 100, y: 60 } });
await settle(1100);
await census("after-stack-click");
await shot("l0-after-click");

// Ctrl+wheel down twice → L2 month stacks (backing sheets visible).
await zoomStep(240);
await zoomStep(240);
await settle();
await census("after-zoom-out-x2");
await shot("l2-months");

// Scroll up through time — older cards deal in, threadline glow moves.
await scrollStep(-1400);
await scrollStep(-1400);
await settle();
await census("after-scroll-up");
await shot("l2-scrolled-up");

// Back to L1, open the strand filter, pick one strand.
await zoomStep(-240);
await settle(400);
await page.getByLabel("筛选时间线").click();
await page.waitForTimeout(600);
await shot("filter-open");
const strandButton = page.locator("[data-slot='popover-content'] button").nth(2);
const strandName = (await strandButton.textContent())?.trim();
await strandButton.click();
await settle(1100);
console.log("selected strand:", strandName);
await census("after-filter");
await shot("l1-filtered");

await browser.close();
console.log(`done: shots/rev10-${THEME}${MOBILE ? "-mobile" : ""}-*.png`);
