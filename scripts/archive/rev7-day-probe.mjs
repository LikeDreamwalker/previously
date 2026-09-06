/**
 * Day-level geometry probe: measure real DOM rects of cards + labels, and
 * capture full-fidelity crops (incl. scrolled/older-month views like the
 * user's "别扭" report). Usage: node scripts/archive/rev7-day-probe.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 1.5,
  colorScheme: "dark",
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

async function measure(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")].map((c) => {
      const r = c.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (c.textContent ?? "").slice(0, 24),
      };
    });
    // Labels are the overlay's mono chip divs.
    const labels = [
      ...document.querySelectorAll(".font-mono.text-\\[11px\\]"),
    ].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), text: c.textContent };
    });
    return { cards, labels };
  });
  console.log(tag, JSON.stringify(info, null, 1));
}

await measure("day-landed");
await page.screenshot({ path: "shots/day-probe-1.png" });

// Scroll toward older months (plain wheel = 穿越时间), let prefetch land.
await page.mouse.move(800, 500);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -700);
  await page.waitForTimeout(900);
}
await page.waitForTimeout(1500);
await measure("day-scrolled");
await page.screenshot({ path: "shots/day-probe-2.png" });

await browser.close();
console.log("done");
