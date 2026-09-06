/**
 * Rev 7 stage check — capture the timeline at the three levels (week/day/hour).
 * Zoom is driven by synthetic WheelEvents (ctrlKey set explicitly) so we do
 * not depend on Playwright modifier propagation.
 * Usage: node scripts/archive/rev7-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 1.5,
  colorScheme: process.env.SCREENSHOT_THEME === "dark" ? "dark" : "light",
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const shot = (name) => page.screenshot({ path: `shots/rev7-${name}.png` });

/** Fire n deliberate zoom steps via synthetic ctrl+wheel on the canvas. */
async function zoom(steps, dir = -240) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((deltaY) => {
      const canvas = document.querySelector("canvas");
      const el = canvas?.parentElement ?? canvas;
      el?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, dir);
    await page.waitForTimeout(2000);
  }
}

/** Card census: count + width of rendered Html cards. */
async function census(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    return {
      cards: cards.length,
      widths: [...new Set(cards.map((c) => c.offsetWidth))].sort((a, b) => a - b),
    };
  });
  console.log(tag, JSON.stringify(info));
}

await census("landed");
await shot("day");

await zoom(1, 240);
await census("after-zoom-out");
await shot("week");

await zoom(1, -240);
await census("after-zoom-in-1");
await shot("day-again");

await zoom(1, -240);
await census("after-zoom-in-2");
await shot("hour");

await page.mouse.move(800, 500);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(1200);
await census("after-scroll");
await shot("hour-scrolled");

await browser.close();
console.log("done: shots/rev7-*.png");
