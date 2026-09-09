/**
 * Rev 11 probe: an L0 card click on /timeline navigates straight to the chat
 * at the slice (`/?at=<sliceId>`), skipping the retired reading panel.
 *
 * - Opens /zh/timeline on the dev server (:3000).
 * - Zooms to L0 if the landing level is coarser.
 * - Clicks an L0 card, records its slice id from the final URL.
 * - Waits for the chat stream to land and scroll to settle.
 * - Asserts the target slice's content is visible in the viewport.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (msg) => console.log("[BROWSER]", msg.text()));

function detectWebGL() {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    } catch {
      return false;
    }
  });
}

async function zoomStep(dir) {
  await page.evaluate((deltaY) => {
    const el =
      document.querySelector("[data-card-field]") ??
      document.querySelector("[data-virtuoso-scroller]") ??
      document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, dir === "in" ? -240 : 240);
  await page.waitForTimeout(2500);
}

async function inspectCards() {
  return page.evaluate(() =>
    [...document.querySelectorAll(".tl-card-in")].map((e) => ({
      label: e.getAttribute("aria-label") ?? "",
      text: e.textContent?.trim() ?? "",
    })),
  );
}

async function pickL0CardInfo() {
  const cards = await inspectCards();
  // L0 slice cards have an aria-label like "08/17 01:21".
  // L1 day stacks: "08/17 Mon · 1"; L2 month stacks: "2026/08 · 3".
  const el = cards.find((c) => /\d{2}\/\d{2}\s+\d{2}:\d{2}$/.test(c.label));
  if (!el) return null;
  const timeMatch = el.label.match(/\d{2}:\d{2}/);
  return { text: el.text, label: el.label, time: timeMatch?.[0] ?? null };
}

async function cardSnapshot(label) {
  const cards = await inspectCards();
  console.log(`[${label}] ${cards.length} cards:`, cards.map((c) => c.label));
  return cards;
}

async function isL0Visible() {
  return (await pickL0CardInfo()) != null;
}

console.log("Opening /zh/timeline...");
await page.goto(`${BASE}/zh/timeline`, { waitUntil: "networkidle" });
// Reload once to pick up the latest HMR bundle from the long-running dev server.
await page.reload({ waitUntil: "networkidle" });
// First hit compiles the three.js chunk; give the field time to mount.
await page.waitForTimeout(4000);

const webgl = await detectWebGL();
console.log("WebGL available:", webgl);

await cardSnapshot("landing");

// Landing is L1 day stacks; step in to reach L0 slices.
if (!(await isL0Visible())) {
  console.log("Zooming in to L0...");
  await zoomStep("in");
  await cardSnapshot("after zoom");
}

const cardInfo = await pickL0CardInfo();
if (!cardInfo || !cardInfo.time) {
  console.error("No L0 slice card found to click.");
  await page.screenshot({ path: "shots/rev11-no-l0.png" });
  process.exitCode = 1;
  await browser.close();
  process.exit(1);
}

console.log("Clicking L0 card:", cardInfo.label);
// Dispatch a click on the actual L0 DOM node. R3F reorders/writes transforms
// every frame, so select by the accessible label that only L0 slice cards have.
await page.evaluate((targetLabel) => {
  const els = [...document.querySelectorAll(".tl-card-in")];
  const el = els.find((e) => e.getAttribute("aria-label") === targetLabel);
  if (!el) {
    console.error("[PROBE] no L0 card with label", targetLabel);
    return;
  }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}, cardInfo.label);

console.log("Waiting for navigation to /?at=<sliceId>...");
try {
  await page.waitForURL(/\?at=/, { timeout: 10_000 });
} catch {
  // The dev server may still be serving the old bundle; check if the retired
  // reading panel opened instead and report it clearly.
  const panelCount = await page.locator("aside[role=dialog]").count();
  console.log("No navigation detected. Reading panel count:", panelCount);
  await page.screenshot({ path: "shots/rev11-no-nav.png" });
  process.exitCode = 1;
  await browser.close();
  process.exit(1);
}

const finalUrl = page.url();
const sliceId = new URL(finalUrl).searchParams.get("at");
console.log("Final URL:", finalUrl);
console.log("Slice id:", sliceId);

// Wait for the unified chat stream to mount and the time-travel scroll to land.
const scroller = page.locator('[data-testid="virtuoso-scroller"]');
await scroller.waitFor({ timeout: 20_000 });

// Scroll settling: the time-travel readout rolls ~2.2s, then Virtuoso scrolls.
await page.waitForTimeout(5500);

// Assert the target slice's seam is visible in the viewport. The seam heading
// shows the localized slice date (e.g. "8月8日" in zh); we derive it from the
// slice id in local time, matching what formatSeamDate() does in the app.
function parseLocalDateZh(sliceId) {
  // id format: 2026-08-07-1808
  const iso = sliceId.replace(
    /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/,
    "$1-$2-$3T$4:$5:00Z",
  );
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
const targetDateZh = parseLocalDateZh(sliceId);
console.log("Expected local seam date:", targetDateZh);

const targetInViewport = await page.evaluate(
  (dateZh) => {
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
    const viewportH = scroller ? scroller.clientHeight : window.innerHeight;
    const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0;

    const walker = document.createTreeWalker(
      scroller ?? document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      if (text.includes(dateZh)) {
        const range = document.createRange();
        range.selectNode(node);
        const rect = range.getBoundingClientRect();
        if (
          rect.top >= viewportTop &&
          rect.bottom <= viewportTop + viewportH &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          return true;
        }
      }
    }
    return false;
  },
  targetDateZh,
);

console.log("Target slice content visible in viewport:", targetInViewport);

if (!targetInViewport) {
  const debug = await page.evaluate((dateZh) => {
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
    const viewportH = scroller ? scroller.clientHeight : window.innerHeight;
    const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const matches = [];
    const walker = document.createTreeWalker(
      scroller ?? document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      if (text.includes("月") || text.includes(dateZh)) {
        const range = document.createRange();
        range.selectNode(node);
        const rect = range.getBoundingClientRect();
        matches.push({
          text: text.trim(),
          inViewport:
            rect.top >= viewportTop &&
            rect.bottom <= viewportTop + viewportH &&
            rect.width > 0 &&
            rect.height > 0,
          top: rect.top,
          bottom: rect.bottom,
        });
      }
    }
    return { viewportTop, viewportH, matches };
  }, targetDateZh);
  console.log("Viewport debug:", debug);
  console.error("FAIL: target slice content is not in the viewport after scroll.");
  process.exitCode = 1;
  await browser.close();
  process.exit(1);
}

console.log("PASS: L0 card click navigated to the slice and landed in view.");
await browser.close();
