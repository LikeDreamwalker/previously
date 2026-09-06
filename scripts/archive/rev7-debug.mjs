import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR STACK:\n", e.stack ?? e.message));

await page.goto("http://localhost:3000/zh/timeline", { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const el = canvas?.parentElement ?? canvas;
  el?.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -240,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
});
await page.waitForTimeout(1500);
await browser.close();
console.log("done");
