/**
 * Rev 11 pile 3D parallax check — verify the card-field backing sheets are real
 * 3D meshes that shift relative to the top card as the camera drifts with scroll.
 *
 * Connects to the running dev server on :3000, switches to L2 (month stacks) so
 * the deepest piles appear, then captures the same visible stack at two scroll
 * positions. The camera drift is tied to scroll progress, so the relative
 * displacement of backing-sheet edges vs the top card should differ between frames.
 *
 * Usage: node scripts/archive/rev11-pile-3d-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const THEME = process.env.SCREENSHOT_THEME === "dark" ? "dark" : "light";
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 1.5,
  colorScheme: THEME,
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));

const HIDE_DEV_CSS = `
  #devtools-indicator, .nextjs-toast, #next-logo,
  [id*="nextjs"], [class*="nextjs-toast"], [id*="devtools-indicator"],
  [data-nextjs-toast], [role="dialog"][class*="nextjs"],
  [class*="nextjs_dev-tools"], [class*="nextjs-static-indicator"],
  nextjs-portal, NEXTJS-PORTAL {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "load" });
await page
  .waitForSelector(".tl-card-in", { timeout: 240000 })
  .catch(() => console.log("WARN: no cards after 240s"));
await page.waitForTimeout(2500);

const shot = (name) =>
  page.screenshot({ path: `shots/rev11-pile-3d-${THEME}-${name}.png` });

async function settle(extraMs = 900) {
  await page.addStyleTag({ content: HIDE_DEV_CSS });
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

async function scrollStep(deltaY) {
  await page.evaluate((dy) => {
    const el = document.querySelector("[data-card-field]") ?? document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }),
    );
  }, deltaY);
  await page.waitForTimeout(900);
}

async function cardCensus(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    return {
      cards: cards.length,
      sample: cards.slice(0, 3).map((c) => c.getAttribute("aria-label") ?? "?"),
    };
  });
  console.log(tag, JSON.stringify(info));
}

await cardCensus("landed");
await settle();

// Zoom out to L2 month stacks so the biggest piles (deepest sheets) are visible.
await zoomStep(240);
await zoomStep(240);
await settle();
await cardCensus("l2-months");
await shot("l2-a");

// Small scroll up: keep both month stacks in the viewport while changing scroll
// progress enough for the camera drift to show layer parallax.
await scrollStep(-220);
await cardCensus("l2-scrolled");
await shot("l2-b");

// Zoom back in to L1 day stacks and capture one more reference frame.
await zoomStep(-240);
await settle();
await cardCensus("l1-day");
await shot("l1");

await browser.close();
console.log(`done: shots/rev11-pile-3d-${THEME}-*.png`);
