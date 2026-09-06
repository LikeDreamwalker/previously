/** Verify the reading panel: land → zoom to hour → click the hour card → shot. */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

async function zoom(dir) {
  await page.evaluate((deltaY) => {
    const canvas = document.querySelector("canvas");
    const el = canvas?.parentElement ?? canvas;
    el?.dispatchEvent(
      new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }, dir);
  await page.waitForTimeout(2200);
}

await zoom(-240); // day → hour... landing is day, one step
await zoom(-240); // ensure hour
console.log("hour cards:", await page.locator(".tl-card-in").count());
await page.waitForTimeout(800);
// Dispatch the click directly — Playwright's actionability check fights the
// easing camera (the card never sits still long enough).
await page.evaluate(() => {
  const el = document.querySelector(".tl-card-in");
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
});
await page.waitForTimeout(2500);
console.log("panel present:", await page.locator("aside[role=dialog]").count());
await page.screenshot({ path: "shots/rev7-reading-panel.png" });

// Esc closes it.
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
console.log("after esc:", await page.locator("aside[role=dialog]").count());

await browser.close();
