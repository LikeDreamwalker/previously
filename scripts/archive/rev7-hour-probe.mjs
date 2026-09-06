/**
 * Identify the huge white box at the hour level: after zooming to hour,
 * walk every visible element under the canvas container and report those
 * wider than 500px with their class + text head.
 */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3101";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

// day -> hour: two zoom-in steps... initial level is day(1), so one step down
// from week? Initial is day. Zoom IN once => hour.
await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const el = canvas?.parentElement ?? canvas;
  el?.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(5000);

const big = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 500 && r.height > 80 && r.top > -50 && r.top < 900) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className?.toString() ?? "").slice(0, 120),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        text: el.childElementCount === 0 ? (el.textContent ?? "").slice(0, 40) : "",
      });
    }
  }
  return out;
});
console.log(JSON.stringify(big, null, 1));
await browser.close();
