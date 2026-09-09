/**
 * Rev 11 portrait density check — screenshot the card field at a phone-like
 * viewport after the pitch tightening (framePitchFor 1.06/1.24 → 1.0/1.1).
 * Usage: node scripts/archive/rev11-portrait-shot.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("shots", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 480, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
await page.goto("http://localhost:3000/zh/timeline", { waitUntil: "load" });
await page
  .waitForSelector(".tl-card-in", { timeout: 240000 })
  .catch(() => console.log("WARN: no cards"));
await page.waitForTimeout(3500);
await page.screenshot({ path: "shots/rev11-portrait-a.png" });
// Scroll up a bit to see two cards + gap mid-stream.
await page.evaluate(() => {
  const el = document.querySelector("[data-card-field]") ?? document.body;
  el.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -800, bubbles: true, cancelable: true }),
  );
});
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/rev11-portrait-b.png" });
await browser.close();
console.log("done: shots/rev11-portrait-*.png");
