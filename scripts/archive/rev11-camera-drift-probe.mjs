/**
 * Rev 11 camera-drift probe — verify the scroll-driven camera drift no longer
 * drags face cards sideways. After the fix (camera.lookAt(0, cy, 0)), every
 * face card (.tl-card-in, z=0) must project to the horizontal center of the
 * card-field canvas at ANY scroll position. Backing sheets sit at z<0 and are
 * allowed to shift (that is the wanted parallax).
 *
 * Connects to the running dev server on :3000. PASS when every visible face
 * card's horizontal center stays within TOL_PX of the canvas center at three
 * scroll positions (top, deep scroll down, scrolled back up).
 *
 * Usage: node scripts/archive/rev11-camera-drift-probe.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const TOL_PX = 6;
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));

await page.goto(`${BASE}/zh/timeline`, { waitUntil: "load" });
await page
  .waitForSelector(".tl-card-in", { timeout: 240000 })
  .catch(() => console.log("WARN: no cards after 240s"));
await page.waitForTimeout(2500);

async function settle() {
  await page
    .waitForFunction(
      () =>
        !document.body.innerText.includes("Rendering…") &&
        !document.body.innerText.includes("Rendering..."),
      { timeout: 60000 },
    )
    .catch(() => console.log("WARN: settle timed out"));
  await page.waitForTimeout(1200);
}

async function scrollStep(deltaY) {
  await page.evaluate((dy) => {
    const el = document.querySelector("[data-card-field]") ?? document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }),
    );
  }, deltaY);
  await page.waitForTimeout(900);
}

function measure(tag) {
  return page.evaluate((t) => {
    const wrap = document.querySelector("[data-card-field]");
    const wrapRect = wrap.getBoundingClientRect();
    const cx = wrapRect.left + wrapRect.width / 2;
    const rows = [...document.querySelectorAll(".tl-card-in")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: (el.getAttribute("aria-label") ?? "?").slice(0, 48),
          dx: +(r.left + r.width / 2 - cx).toFixed(1),
          visible: r.height > 10 && r.bottom > 0 && r.top < innerHeight,
        };
      })
      .filter((r) => r.visible);
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.dx)), 0);
    return { tag: t, canvasCx: +cx.toFixed(1), maxAbsDx: maxAbs, rows };
  }, tag);
}

const results = [];

await settle();
results.push(await measure("initial"));
await page.screenshot({ path: "shots/rev11-drift-a.png" });

// Deep scroll down (toward newest) — big enough to swing progress far from 0.
for (let i = 0; i < 6; i++) await scrollStep(600);
await settle();
results.push(await measure("scrolled-down"));
await page.screenshot({ path: "shots/rev11-drift-b.png" });

// Scroll back up (toward oldest), stop mid-way.
for (let i = 0; i < 3; i++) await scrollStep(-600);
await settle();
results.push(await measure("scrolled-up"));
await page.screenshot({ path: "shots/rev11-drift-c.png" });

let pass = true;
for (const r of results) {
  const ok = r.maxAbsDx <= TOL_PX;
  if (!ok) pass = false;
  console.log(
    `${r.tag}: canvasCx=${r.canvasCx} maxAbsDx=${r.maxAbsDx}px ${ok ? "OK" : "FAIL"}`,
  );
  for (const row of r.rows) {
    if (Math.abs(row.dx) > TOL_PX) console.log(`   off: ${row.dx}px  ${row.label}`);
  }
}
console.log(pass ? "DRIFT PROBE PASS" : "DRIFT PROBE FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
