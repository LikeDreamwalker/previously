/**
 * Screenshot helper — captures named screenshots of the app for README/docs.
 *
 * Usage:
 *   node scripts/screenshot.mjs                          # default shot set (dark-primary)
 *   node scripts/screenshot.mjs --route /en/settings --theme dark --out shots/settings-dark.png
 *   node scripts/screenshot.mjs --route /en --theme light --out shots/chat-light.png
 *   node scripts/screenshot.mjs --route /en --scale 4 --out shots/chat-4x.png
 *   node scripts/screenshot.mjs --selector ".scrollbar-none" --out shots/timeline.png
 *   node scripts/screenshot.mjs --demo --theme dark --out shots/conversation.png
 *   node scripts/screenshot.mjs --after-demo --selector "div.rounded-lg.px-3.py-2.5" --out shots/recall-card.png
 *
 * Requires the app to be running (default http://localhost:3000; override with
 * --base or the SCREENSHOT_BASE env var).
 *
 * Theme is emulated via `prefers-color-scheme` — the app's next-themes default
 * is "system", so this switches the rendered theme without touching storage.
 * Shots are captured at 2x device scale by default (use --scale 3/4 for
 * ultra-high-DPI).
 *
 * The Next.js dev-mode indicator (#devtools-indicator / .nextjs-toast) is
 * hidden via injected CSS so local captures look production-clean. Shots wait
 * for animations to finish (fonts ready + a generous settle beat) before the
 * shutter fires. Dark mode is the default theme for the shot set.
 *
 * `--selector <css>` captures only the matched element (element-level shot).
 * `--demo` drives the app's own "Render demo" button, waits for the mock
 * streaming sequence to complete (thinking → recall → tools → answer →
 * self-evolution), then captures the finished conversation as a viewport shot
 * scrolled to the conversation (NOT a full-page shot — sticky elements don't
 * align in full-page captures).
 * `--after-demo --selector <css>` runs the same demo flow but then screenshots
 * a single element (e.g. the recall card), which only exists after the demo.
 *
 * NOTE: when run from Git Bash (MSYS), a leading-slash route like `--route /en`
 * gets path-converted to `C:/Program Files/Git/en`. Prefix the command with
 * MSYS_NO_PATHCONV=1 (or run from PowerShell) to avoid that.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
/** Screenshots live in public/ so the README can reference them by relative path. */
const OUT_DIR = "public/screenshots";

/** Default shot set — dark-primary. Locale is baked into the route. */
const DEFAULT_SHOTS = [
  { name: "chat-dark", path: "/en", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "chat-light", path: "/en", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "chat-mobile-dark", path: "/en", theme: "dark", viewport: { width: 390, height: 844 } },
  { name: "settings-dark", path: "/en/settings", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "settings-light", path: "/en/settings", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "docs-dark", path: "/en/docs", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "docs-light", path: "/en/docs", theme: "light", viewport: { width: 1440, height: 900 } },
];

/** ms to let the page settle (hydration, theme class, fonts, animations). */
const SETTLE_MS = 3500;

/** How long the full mock stream takes to finish (sum of the step delays). */
const DEMO_TIMEOUT_MS = 60_000;

/** Injected CSS — hides the Next.js dev-mode indicator + any stray corner chrome. */
const HIDE_DEV_CSS = `
  #devtools-indicator, .nextjs-toast, #next-logo,
  [id*="nextjs"], [class*="nextjs-toast"], [id*="devtools-indicator"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;

function parseArgs(argv) {
  const args = { shots: DEFAULT_SHOTS, fullPage: false, scale: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--route") args.single = { path: argv[++i] };
    else if (a === "--theme") args.single ??= {}, args.single.theme = argv[++i];
    else if (a === "--out") args.single ??= {}, args.single.out = argv[++i];
    else if (a === "--viewport") {
      const [w, h] = argv[++i].split("x").map(Number);
      args.single ??= {}, args.single.viewport = { width: w, height: h };
    } else if (a === "--scale") args.scale = parseInt(argv[++i], 10) || 2;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--full-page") args.fullPage = true;
    else if (a === "--selector") args.selector = argv[++i];
    else if (a === "--demo") args.demo = true;
    else if (a === "--after-demo") args.afterDemo = true;
  }
  return args;
}

/** Inject the dev-indicator-hiding CSS once the page is up. */
async function hideDevIndicator(page) {
  await page.addStyleTag({ content: HIDE_DEV_CSS });
}

/** Shared settle helper — fonts + a generous beat for animations to finish. */
async function settle(page) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

/** Shared navigation — load, hide dev indicator, settle. */
async function openPage(page, route, { fullPage = false } = {}) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
  await hideDevIndicator(page);
  await settle(page);
}

async function captureShot(browser, shot, outPath, fullPage, scale, selector) {
  const context = await browser.newContext({
    viewport: shot.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: scale,
    colorScheme: shot.theme,
  });
  try {
    const page = await context.newPage();
    await openPage(page, shot.path);
    if (selector) {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForTimeout(400);
      await locator.screenshot({ path: outPath });
    } else {
      await page.screenshot({ path: outPath, fullPage: fullPage });
    }
    console.log(`✓ ${outPath} (${shot.theme})`);
  } finally {
    await context.close();
  }
}

/**
 * Drives the in-app "Render demo" button, waits for the mock stream to finish,
 * then captures the conversation as a VIEWPORT shot scrolled to the message
 * (not full-page — sticky elements misalign in tall full-page captures).
 */
async function captureDemoConversation(browser, outPath, scale, theme) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: scale,
    colorScheme: theme,
  });
  try {
    const page = await context.newPage();
    await openPage(page, "/en");

    // The demo trigger is the FlaskConical icon button in the input bar.
    const demoButton = page.locator('button:has(svg.lucide-flask-conical)');
    await demoButton.first().waitFor({ state: "visible", timeout: 15_000 });
    await demoButton.first().click();

    // Wait until the mock stream finishes — the demo button re-enables when
    // demoRunning drops back to false.
    await page.waitForFunction(
      () => {
        const btn = document
          .querySelector("button svg.lucide-flask-conical")
          ?.closest("button");
        return btn && !btn.disabled;
      },
      null,
      { timeout: DEMO_TIMEOUT_MS },
    );

    // Let the answer text + evolution card animations finish.
    await settle(page);

    // Scroll the final assistant message into view so the shot frames the
    // conversation (cards + answer) rather than the empty hero.
    const lastAssistant = page.locator('[data-role="assistant"]').last();
    if (await lastAssistant.count()) {
      await lastAssistant.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
    }

    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`✓ ${outPath} (demo conversation, ${theme})`);
  } finally {
    await context.close();
  }
}

/**
 * Runs the demo flow, then captures a single element that only exists after
 * the mock stream completes (e.g. the recall card). `selector` picks the
 * element; the demo is driven the same way as captureDemoConversation.
 */
async function captureDemoElement(browser, selector, outPath, scale, theme) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: scale,
    colorScheme: theme,
  });
  try {
    const page = await context.newPage();
    await openPage(page, "/en");

    const demoButton = page.locator('button:has(svg.lucide-flask-conical)');
    await demoButton.first().waitFor({ state: "visible", timeout: 15_000 });
    await demoButton.first().click();

    await page.waitForFunction(
      () => {
        const btn = document
          .querySelector("button svg.lucide-flask-conical")
          ?.closest("button");
        return btn && !btn.disabled;
      },
      null,
      { timeout: DEMO_TIMEOUT_MS },
    );

    // Expand the element first (e.g. recall card opens to reveal the hits).
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    await locator.click().catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await locator.screenshot({ path: outPath });
    console.log(`✓ ${outPath} (demo element, ${theme})`);
  } finally {
    await context.close();
  }
}

async function main() {
  const { shots, single, fullPage, base, scale, selector, demo, afterDemo } =
    parseArgs(process.argv.slice(2));
  const baseUrl = base ?? BASE;

  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    // Demo-then-element: --after-demo --selector .foo [--out file] [--theme t].
    if (afterDemo) {
      const out =
        single?.out ?? path.join(OUT_DIR, `element-${shotSuffix(selector ?? "")}.png`);
      await captureDemoElement(
        browser,
        selector,
        out,
        scale,
        single?.theme ?? "dark",
      );
      console.log(`Captured demo element: ${out}`);
      return;
    }

    // Element-level single shot: --selector .foo [--out file] [--theme t].
    if (selector) {
      const out =
        single?.out ?? path.join(OUT_DIR, `element-${shotSuffix(selector)}.png`);
      const shot = {
        path: single?.path ?? "/en",
        theme: single?.theme ?? "dark",
        viewport: single?.viewport,
      };
      await captureShot(browser, shot, out, false, scale, selector);
      console.log(`Captured element: ${out}`);
      return;
    }

    // Demo conversation shot: --demo [--out file] [--theme t].
    if (demo) {
      const out =
        single?.out ?? path.join(OUT_DIR, `conversation-${single?.theme ?? "dark"}.png`);
      await captureDemoConversation(browser, out, scale, single?.theme ?? "dark");
      return;
    }

    // Single-shot mode: --route X [--theme t] [--out file] [--viewport WxH] [--scale N].
    if (single) {
      const shot = {
        path: single.path,
        theme: single.theme ?? "dark",
        viewport: single.viewport,
      };
      const out = single.out ?? path.join(OUT_DIR, `shot-${shot.theme}.png`);
      await captureShot(browser, shot, out, fullPage, scale);
      console.log(`Captured: ${out}`);
      return;
    }

    // Default shot set.
    for (const shot of shots) {
      const out = path.join(OUT_DIR, `${shot.name}.png`);
      await captureShot(browser, shot, out, fullPage, scale);
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone — ${shots.length} screenshots in ${OUT_DIR}/`);
}

/** Sanitize a CSS selector into a filesystem-safe suffix. */
function shotSuffix(selector) {
  return selector
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "shot";
}

main().catch((err) => {
  console.error("Screenshot failed:", err?.message ?? err);
  process.exit(1);
});
