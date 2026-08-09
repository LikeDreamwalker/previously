/**
 * Screenshot helper — captures named screenshots of the app for README/docs.
 *
 * Usage:
 *   node scripts/screenshot.mjs                          # default shot set
 *   node scripts/screenshot.mjs --route /en/settings --theme dark --out shots/settings-dark.png
 *   node scripts/screenshot.mjs --route /en --full-page --out shots/chat-light.png
 *   node scripts/screenshot.mjs --route /en --scale 4 --out shots/chat-4x.png
 *
 * Requires the app to be running (default http://localhost:3000; override with
 * --base or the SCREENSHOT_BASE env var).
 *
 * Theme is emulated via `prefers-color-scheme` — the app's next-themes default
 * is "system", so this switches the rendered theme without touching storage.
 * Shots are captured at 2x device scale by default (use --scale 3/4 for
 * ultra-high-DPI), and the page is given time to hydrate (fonts, theme class,
 * streaming fade) before the shutter fires.
 *
 * NOTE: when run from Git Bash (MSYS), a leading-slash route like `--route /en`
 * gets path-converted to `C:/Program Files/Git/en`. Prefix the command with
 * MSYS_NO_PATHCONV=1 (or run from PowerShell) to avoid that.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const OUT_DIR = "screenshots";

/** Default shot set — the core pages × theme. Locale is baked into the route. */
const DEFAULT_SHOTS = [
  { name: "chat-light", path: "/en", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "chat-dark", path: "/en", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "chat-mobile", path: "/en", theme: "light", viewport: { width: 390, height: 844 } },
  { name: "settings-light", path: "/en/settings", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "settings-dark", path: "/en/settings", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "docs-light", path: "/en/docs", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "docs-dark", path: "/en/docs", theme: "dark", viewport: { width: 1440, height: 900 } },
];

/** ms to let the page settle (hydration, theme class, fonts, animations). */
const SETTLE_MS = 700;

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
  }
  return args;
}

async function captureShot(browser, shot, outPath, fullPage, scale) {
  const context = await browser.newContext({
    viewport: shot.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: scale,
    colorScheme: shot.theme,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle", timeout: 30_000 });
    // Let hydration + theme + fonts settle before the shutter fires.
    await page.waitForTimeout(SETTLE_MS);
    // Rely on the app's own layout animations to finish; a short extra beat
    // after network idle keeps hero/reveal effects from being caught mid-air.
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.screenshot({ path: outPath, fullPage: fullPage });
    console.log(`✓ ${outPath} (${shot.theme})`);
  } finally {
    await context.close();
  }
}

async function main() {
  const { shots, single, fullPage, base, scale } = parseArgs(process.argv.slice(2));
  const baseUrl = base ?? BASE;

  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    // Single-shot mode: --route X [--theme t] [--out file] [--viewport WxH] [--scale N].
    if (single) {
      const shot = {
        path: single.path,
        theme: single.theme ?? "light",
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

main().catch((err) => {
  console.error("Screenshot failed:", err?.message ?? err);
  process.exit(1);
});
