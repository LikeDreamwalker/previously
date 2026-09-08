/**
 * Rev 11 card redesign stage check — capture the new dossier/specimen card
 * face on the running dev server (:3000).
 *
 * Shots: desktop light, desktop dark, narrow mobile (390px).
 * Waits for real card content (bubbles / ledger / previously) before shooting.
 *
 * Usage: node scripts/archive/rev11-card-redesign-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
mkdirSync("shots", { recursive: true });

const browser = await chromium.launch();

/** Hide Next.js dev-mode chrome (indicator, issue badge, compile toasts). */
const HIDE_DEV_CSS = `
  #devtools-indicator, .nextjs-toast, #next-logo,
  [id*="nextjs"], [class*="nextjs-toast"], [id*="devtools-indicator"],
  [data-nextjs-toast], [role="dialog"][class*="nextjs"],
  [class*="nextjs_dev-tools"], [class*="nextjs-static-indicator"],
  nextjs-portal, NEXTJS-PORTAL {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;

/** Wait for the R3F card field to render cards and load real content. */
async function settle(page, extraMs = 1200) {
  await page.addStyleTag({ content: HIDE_DEV_CSS });
  await page
    .waitForSelector(".tl-card-in", { timeout: 120000 })
    .catch(() => console.log("WARN: no cards after 120s"));
  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        const compiling =
          text.includes("Rendering…") ||
          text.includes("Rendering...") ||
          text.includes("Compiling…") ||
          text.includes("Compiling...");
        return (
          !compiling &&
          (
            [...document.querySelectorAll(".tl-card-in .line-clamp-3")].some(
              (el) => el.textContent.trim().length > 0,
            ) ||
            [...document.querySelectorAll(".tl-card-in")].some((card) =>
              /(TONE|DECIDED|OPEN|STRANDS|基调|决定|未决|线索|❝)/.test(
                card.textContent,
              ),
            )
          )
        );
      },
      { timeout: 60000 },
    )
    .catch(() => console.log("WARN: content settle timed out"));
  // Give HMR one more beat to finish; if a compile indicator reappears,
  // wait it out (with a capped retry).
  await page.waitForTimeout(extraMs);
  for (let i = 0; i < 20; i++) {
    const stillCompiling = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      return (
        text.includes("Rendering…") ||
        text.includes("Rendering...") ||
        text.includes("Compiling…") ||
        text.includes("Compiling...")
      );
    });
    if (!stillCompiling) break;
    await page.waitForTimeout(500);
  }
}

async function capture({ name, theme, viewport, isMobile = false }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: isMobile ? 2 : 1.5,
    isMobile,
    hasTouch: isMobile,
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));

  await page.goto(`${BASE}/zh/timeline`, { waitUntil: "load" });
  await settle(page, isMobile ? 1600 : 1200);

  // Strip any dev-mode compile/render toasts that survived the CSS hide.
  await page
    .evaluate(() => {
      const strip = (el) => {
        const text = el.textContent ?? "";
        if (
          /Rendering|Compiling/i.test(text) &&
          (text.length < 40 || /nextjs|next\.js/i.test(el.className))
        ) {
          el.remove();
        }
      };
      document.querySelectorAll("*").forEach(strip);
    })
    .catch(() => {});

  const path = `shots/rev11-card-redesign-${name}.png`;
  await page.screenshot({ path });
  console.log(`✓ ${path} (${theme}${isMobile ? ", mobile" : ""})`);

  await context.close();
}

await capture({
  name: "desktop-light",
  theme: "light",
  viewport: { width: 1600, height: 950 },
});
await capture({
  name: "desktop-dark",
  theme: "dark",
  viewport: { width: 1600, height: 950 },
});
await capture({
  name: "narrow",
  theme: "dark",
  viewport: { width: 390, height: 844 },
  isMobile: true,
});

await browser.close();
console.log("done: shots/rev11-card-redesign-*.png");
