/**
 * Post-refactor check against the main dev server (:3000): the RegionOverlay
 * (single DOM tree) should mount cards IMMEDIATELY after a zoom flight —
 * census right after landing must already show the full card set.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

async function wheel(deltaY) {
  await page.evaluate((dy) => {
    const canvas = document.querySelector("canvas");
    const el = canvas?.parentElement ?? canvas;
    el?.dispatchEvent(
      new WheelEvent("wheel", { deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }, deltaY);
}

async function census(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    const visible = cards.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && getComputedStyle(c).opacity !== "0";
    });
    return { cards: cards.length, visible: visible.length };
  });
  console.log(tag, JSON.stringify(info));
}

await census("day-landed");
await page.screenshot({ path: "shots/ref-day.png" });

await wheel(240); // -> week
await page.waitForTimeout(1200);
await census("week-t+1.2s");
await page.screenshot({ path: "shots/ref-week.png" });

await wheel(-240); // -> day
await page.waitForTimeout(1200);
await census("day2-t+1.2s");

await wheel(-240); // -> hour
await page.waitForTimeout(1500);
await census("hour-t+1.5s");
await page.screenshot({ path: "shots/ref-hour.png" });

await browser.close();
console.log("done: shots/ref-*.png");
