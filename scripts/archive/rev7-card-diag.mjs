/**
 * Week-tier card visibility diagnostic: sample the DOM at several time
 * points, before and after a ctrl+wheel level step. For each sample dump
 * card count, flying-class count, per-card rects (first 6), label rects
 * (first 6), and any page errors.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 200));
});

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });

async function sample(tag) {
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    const labels = [...document.querySelectorAll("div")]
      .filter(
        (d) =>
          d.children.length === 0 &&
          /^\d{2}-\d{2} – \d{2}-\d{2}$/.test(d.textContent?.trim() ?? ""),
      )
      .map((d) => {
        const r = d.getBoundingClientRect();
        return { text: d.textContent?.trim(), x: Math.round(r.x), y: Math.round(r.y) };
      });
    return {
      cardCount: cards.length,
      flyingCount: cards.filter((c) => c.classList.contains("tl-flying")).length,
      cards: cards.slice(0, 6).map((c) => {
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        return {
          text: c.textContent?.slice(0, 18),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          opacity: cs.opacity,
          display: cs.display,
        };
      }),
      labelCount: labels.length,
      labels: labels.slice(0, 6),
      rendering: !!document.body.textContent?.includes("Rendering"),
    };
  });
  console.log(`--- ${tag} ---`);
  console.log(JSON.stringify(info));
}

await sample("t+0s (pre-wheel, after networkidle)");
await page.waitForTimeout(2000);
await sample("t+2s");
await page.waitForTimeout(2000);
await sample("t+4s");

// one zoom-in step (week -> day flight)
await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const el = canvas?.parentElement ?? canvas;
  el?.dispatchEvent(
    new WheelEvent("wheel", { deltaY: 240, ctrlKey: true, bubbles: true, cancelable: true }),
  );
});
await page.waitForTimeout(1000);
await sample("post-wheel t+1s");
await page.waitForTimeout(2000);
await sample("post-wheel t+3s");
await page.waitForTimeout(2000);
await sample("post-wheel t+5s");

await page.screenshot({ path: "shots/rev7-diag-final.png" });
await browser.close();
