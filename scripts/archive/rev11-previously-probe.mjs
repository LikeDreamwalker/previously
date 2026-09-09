/**
 * Rev 11 previously-placeholder probe — verify no card renders the degenerate
 * "❝ Previously On ❞" boilerplate (bare heading with no real excerpt).
 * Usage: node scripts/archive/rev11-previously-probe.mjs
 */
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto("http://localhost:3000/zh/timeline", { waitUntil: "load" });
await page.waitForSelector(".tl-card-in", { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(4000);
const hits = await page.evaluate(() =>
  [...document.querySelectorAll(".tl-card-in")].map((c) => ({
    label: (c.getAttribute("aria-label") ?? "?").slice(0, 30),
    hasBarePreviously: /❝\s*Previously On\s*❞/.test(c.textContent),
  })),
);
console.log(JSON.stringify(hits, null, 1));
const bad = hits.filter((h) => h.hasBarePreviously);
console.log(bad.length === 0 ? "PREVIOUSLY PROBE PASS" : "PREVIOUSLY PROBE FAIL");
await browser.close();
process.exit(bad.length === 0 ? 0 : 1);
