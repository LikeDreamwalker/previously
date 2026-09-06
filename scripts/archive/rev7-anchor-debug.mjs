/** Debug: zoom round-trip day→week→day, dump card DOM state at each step. */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log("CONSOLE:", m.type(), m.text().slice(0, 200));
});

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

async function zoom(dir) {
  await page.evaluate((deltaY) => {
    const canvas = document.querySelector("canvas");
    const el = canvas?.parentElement ?? canvas;
    el?.dispatchEvent(
      new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }, dir);
  await page.waitForTimeout(1600);
}

async function dump(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")].map((d) => {
      const r = d.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        text: (d.textContent ?? "").slice(0, 30),
        visible: r.width > 0 && r.height > 0,
        opacity: getComputedStyle(d).opacity,
      };
    });
    return cards;
  });
  console.log(tag, JSON.stringify(info, null, 0));
}

async function dumpSeries(tag) {
  for (const wait of [400, 800, 1500, 3000]) {
    await page.waitForTimeout(wait);
    const n = await page.evaluate(
      () => document.querySelectorAll(".tl-card-in").length,
    );
    console.log(`${tag} +${wait}ms: ${n} cards`);
  }
  await dump(tag + "-final");
}

await dump("landed");
await zoom(240); // out → week
await dumpSeries("week");
await zoom(-240); // in → day
await dumpSeries("day-again");

await browser.close();
