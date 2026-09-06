/** Verify catalog paging: land (latest 2 months), scroll to the oldest
 *  loaded entries, expect an older-month prefetch (June appears). */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

const labels = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("div")]
      .map((d) => (d.children.length === 0 ? d.textContent?.trim() : null))
      .filter((t) => t && /^\d{2}\/\d{2}/.test(t))
      .slice(0, 12),
  );

console.log("landed labels:", JSON.stringify(await labels()));

// Scroll up (toward older) in bursts until June labels appear or we give up.
for (let burst = 0; burst < 12; burst++) {
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const el = canvas?.parentElement ?? canvas;
      el?.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -480, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500); // let a prefetch land + relay out
  const ls = await labels();
  console.log(`burst ${burst}:`, JSON.stringify(ls));
  if (ls.some((t) => t?.startsWith("06/"))) {
    console.log("PAGING OK — June loaded");
    break;
  }
}
await page.screenshot({ path: "shots/rev7-paging-top.png" });
await browser.close();
