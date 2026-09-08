/** Rev 10 debug probe — console errors + card census on /zh/timeline. */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  colorScheme: "dark",
});
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log(`CONSOLE[${m.type()}]:`, m.text().slice(0, 300));
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 500)));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(4500);

const info = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".tl-card-in")];
  const canvasCount = document.querySelectorAll("canvas").length;
  const field = document.querySelector("[data-card-field]");
  const htmlDivs = [...document.querySelectorAll("[data-card-field] div")].slice(0, 5).map((d) => ({
    cls: d.className?.toString().slice(0, 60),
    rect: d.getBoundingClientRect().toJSON(),
  }));
  return {
    cards: cards.length,
    labels: cards.slice(0, 4).map((c) => c.getAttribute("aria-label")),
    canvasCount,
    fieldRect: field?.getBoundingClientRect().toJSON(),
    htmlDivs,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "shots/rev10-probe.png" });
await browser.close();
