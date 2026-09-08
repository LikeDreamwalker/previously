/**
 * Rev 8 stage check — capture the stack-list timeline at L1 (landing),
 * L0 (after clicking a stack), L2 (after ctrl+wheel zoom-out), the strand
 * filter, and an upward page prepend.
 *
 * Gestures are synthetic events dispatched on the virtuoso scroller (they
 * bubble to the StackList wrap's non-passive listeners) so we do not depend
 * on Playwright modifier propagation.
 * Usage: node scripts/archive/rev8-shots.mjs  (SCREENSHOT_THEME=dark for dark)
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
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const shot = (name) =>
  page.screenshot({
    path: `shots/rev8-${THEME}${MOBILE ? "-mobile" : ""}-${name}.png`,
  });

/** Fire one level step via synthetic ctrl+wheel on the list scroller. */
async function zoomStep(deltaY) {
  await page.evaluate((dy) => {
    const el =
      document.querySelector("[data-virtuoso-scroller]") ?? document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: dy,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, deltaY);
  await page.waitForTimeout(900);
}

/** Row census: count + aria labels sample. */
async function census(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    return {
      cards: cards.length,
      sample: cards
        .slice(0, 3)
        .map((c) => c.getAttribute("aria-label") ?? c.textContent?.slice(0, 30)),
    };
  });
  console.log(tag, JSON.stringify(info));
}

await census("landed");
await shot("l1-landing");

// Click a day stack → the whole view steps to L0 anchored on that day.
const stack = page.locator(".tl-card-in").nth(3);
await stack.scrollIntoViewIfNeeded();
await stack.click();
await page.waitForTimeout(900);
await census("after-stack-click");
await shot("l0-after-click");

// Ctrl+wheel down twice → L2 month stacks.
await zoomStep(240);
await zoomStep(240);
await census("after-zoom-out-x2");
await shot("l2-months");

// Back to L1, then open the strand filter and pick one strand.
await zoomStep(-240);
await page.getByLabel("筛选时间线").click();
await page.waitForTimeout(400);
await shot("filter-open");
const strandButton = page
  .locator("[data-slot='popover-content'] button")
  .nth(2);
const strandName = (await strandButton.textContent())?.trim();
await strandButton.click();
await page.waitForTimeout(900);
console.log("selected strand:", strandName);
await census("after-filter");
await shot("l1-filtered");

// Scroll up hard → older month page prepends.
const scroller = page.locator("[data-virtuoso-scroller]");
await scroller.hover();
for (let i = 0; i < 14; i++) {
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(1200);
await census("after-scroll-up");
await shot("l1-scrolled-up");

await browser.close();
console.log(`done: shots/rev8-${THEME}-*.png`);
