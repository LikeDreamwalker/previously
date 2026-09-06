/**
 * Dump ALL week-level card rects + a same-session screenshot, to check
 * whether cards align with the rendered strand lines.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const el = canvas?.parentElement ?? canvas;
  el?.dispatchEvent(
    new WheelEvent("wheel", { deltaY: 240, ctrlKey: true, bubbles: true, cancelable: true }),
  );
});
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".tl-card-in")];
  const labels = [...document.querySelectorAll("div")]
    .filter((d) => d.children.length === 0 && /^\d{2}-\d{2} – \d{2}-\d{2}$/.test(d.textContent?.trim() ?? ""))
    .map((d) => {
      const r = d.getBoundingClientRect();
      return { text: d.textContent?.trim(), x: Math.round(r.x), y: Math.round(r.y) };
    });
  return {
    cards: cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { text: c.textContent?.slice(0, 24), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    }),
    labels,
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: "shots/rev7-week-probe.png" });
await browser.close();
