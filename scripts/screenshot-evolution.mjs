/**
 * One-off driver: capture a REAL evolution run's EvolutionCard for the README.
 *
 * Preconditions: dev server running with STORAGE=local, PREVIOUSLY_MODE=client,
 * MEMORY_ROOT pointed at the seeded fictional memory (see task brief).
 *
 * Flow: open /en → submit a complaint message that fits the seeded story →
 * the fitness trigger (interaction net -5) fires the merged evolution run
 * inline → screenshot the card mid-run (optional) and settled+expanded.
 *
 * Usage: node scripts/screenshot-evolution.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3101";
const OUT_DIR = "public/screenshots";
const MESSAGE =
  "Honestly, your last few answers felt generic again — you keep missing what I actually asked.";

const HIDE_DEV_CSS = `
  #devtools-indicator, .nextjs-toast, #next-logo,
  [id*="nextjs"], [class*="nextjs-toast"], [id*="devtools-indicator"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;

/** The EvolutionCard = PhaseIndicator motion.div whose header holds the Sparkles icon.
 *  NOTE: while running, the icon is swapped for a Loader2 spinner, so this
 *  selector only matches the SETTLED card — the running card is found by its
 *  label text ("Self-evolving…") instead. */
const CARD_SELECTOR = "div:has(> div > span > svg.lucide-sparkles)";
const RUNNING_SELECTOR = 'div.rounded-lg:has-text("Self-evolving")';

const TURN_BUDGET_MS = 10 * 60 * 1000;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser:error]", msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 300)));

  try {
    console.log(`Opening ${BASE}/en ...`);
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.addStyleTag({ content: HIDE_DEV_CSS });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(3500);

    const input = page.locator("textarea").first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(MESSAGE);
    await page.waitForTimeout(300);
    console.log("Submitting message:", MESSAGE);
    await input.press("Enter");

    // Mid-run capture: the running card shows a spinner instead of the
    // Sparkles icon, so find it by its "Self-evolving…" label. Poll until it
    // appears (housekeeping runs first), then wait for a live thinking line.
    let runningShot = false;
    const runningCard = page.locator(RUNNING_SELECTOR).last();
    const runningDeadline = Date.now() + 540_000;
    try {
      for (;;) {
        if (await runningCard.isVisible().catch(() => false)) break;
        // Already settled before we ever saw it running? Then give up on the
        // running shot and move on.
        if (await page.locator(CARD_SELECTOR).first().isVisible().catch(() => false)) break;
        if (Date.now() > runningDeadline) throw new Error("evolution card never appeared");
        await page.waitForTimeout(1500);
      }
      if (await runningCard.isVisible().catch(() => false)) {
        console.log("Running evolution card visible — waiting for a live line…");
        // The coarse step wordings are fallbacks, not live lines — skip them.
        const COARSE = [
          "Reading memory",
          "Reviewing conversation patterns",
          "Evaluating the evolution direction",
          "Applying update",
        ];
        // Wait until the subtitle carries a real thinking line (or 60s max).
        for (let i = 0; i < 60; i++) {
          const text = await runningCard.innerText().catch(() => "");
          const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
          const hasLiveLine = lines.some(
            (l) =>
              l.length > 25 &&
              !l.startsWith("Self-evolving") &&
              !/^\d+s$/.test(l) &&
              !COARSE.some((c) => l.startsWith(c)),
          );
          if (hasLiveLine) break;
          if (!(await runningCard.isVisible().catch(() => false))) break; // settled
          await page.waitForTimeout(1000);
        }
        if (await runningCard.isVisible().catch(() => false)) {
          await runningCard.scrollIntoViewIfNeeded();
          await page.waitForTimeout(400);
          await runningCard.screenshot({ path: `${OUT_DIR}/evolution-running.png` });
          console.log("✓ evolution-running.png (mid-run)");
          console.log("Mid-run card text:", (await runningCard.innerText()).replace(/\n/g, " | ").slice(0, 200));
          runningShot = true;
        }
      }
    } catch (e) {
      console.log("Mid-run capture skipped:", e?.message ?? e);
    }

    // Wait for the evolution card to settle (the Sparkles icon returns).
    const card = page.locator(CARD_SELECTOR).first();
    await card.waitFor({ state: "visible", timeout: 540_000 });
    console.log("Evolution card appeared (settled).");

    // Wait for the run to settle: spinner gone + expand chevron present.
    const deadline = Date.now() + TURN_BUDGET_MS;
    for (;;) {
      const spinning = await card.locator("svg.animate-spin").count();
      const hasChevron = await card.locator("svg.lucide-chevron-down").count();
      if (spinning === 0 && hasChevron > 0) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for the evolution run to settle");
      await page.waitForTimeout(3000);
    }
    console.log("Evolution run settled. Card text:", (await card.innerText()).replace(/\n/g, " | ").slice(0, 300));

    // Expand the detail (trigger lines / direction outcome / mutation diff).
    await card.click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await card.screenshot({ path: `${OUT_DIR}/evolution-card.png` });
    // Also keep a per-run copy so a later retry can never clobber a good shot.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await card.screenshot({ path: `${OUT_DIR}/evolution-card-${stamp}.png` });
    console.log("✓ evolution-card.png (settled, expanded)");
    console.log("Expanded card text:\n" + (await card.innerText()).slice(0, 1200));

    // Wait for the assistant answer to finish streaming so the page is calm.
    await page.waitForTimeout(5000);
    if (!runningShot) console.log("(no mid-run shot — run settled too fast)");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Driver failed:", err?.message ?? err);
  process.exit(1);
});
