import { test, expect } from "@playwright/test";

// Current routes: chat lives at the locale root (/), with settings as the only
// sub-route. Docs moved to the official site — in-app /docs URLs are 308
// redirects (next.config.ts), and the header Docs link is external. Navigation
// is the top AppHeader (Previously / GitHub / Docs / Settings) — there is no
// sidebar. Header link hrefs are locale-prefixed (/en/settings, ...), so tests
// select them by href.
const ROUTES = ["/", "/settings"] as const;

test.describe("Navigation", () => {
  for (const route of ROUTES) {
    test(`GET ${route} returns 200`, async ({ page }) => {
      const res = await page.goto(`/en${route === "/" ? "" : route}`);
      expect(res?.status()).toBe(200);
    });
  }

  test("unknown routes return 404", async ({ page }) => {
    const res = await page.goto("/en/does-not-exist");
    expect(res?.status()).toBe(404);
  });

  test("chat page shows the empty briefing and a chat input", async ({ page }) => {
    await page.goto("/en");
    // The hero was removed — the "PREVIOUSLY ON {name}" eyebrow now opens the
    // empty briefing (the product's arrival moment) instead.
    await expect(page.getByText(/^PREVIOUSLY ON /)).toBeVisible();
    await expect(page.locator("textarea")).toBeVisible();
  });

  test("settings page renders the settings form", async ({ page }) => {
    await page.goto("/en/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.locator("input").first()).toBeVisible();
  });

  // Docs redirects — assert the 308 without following it (the destination is
  // the external docs site).
  test("/docs redirects (308) to the docs site", async ({ request }) => {
    const res = await request.get("/en/docs", { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toBe(
      "https://previously.ldwid.com/en/docs",
    );
  });

  test("/docs/:slug redirects (308) to the matching site page", async ({
    request,
  }) => {
    const res = await request.get("/zh/docs/slices", { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toBe(
      "https://previously.ldwid.com/zh/docs/slices",
    );
  });

  test("header Docs link points at the external docs site", async ({
    page,
  }) => {
    await page.goto("/en");
    const docs = page.locator(
      'header a[href="https://previously.ldwid.com/en/docs"]',
    );
    await expect(docs).toBeVisible();
    await expect(docs).toHaveAttribute("target", "_blank");
  });

  test("header Settings link navigates to settings", async ({ page }) => {
    await page.goto("/en");
    await page.click('header a[href="/en/settings"]');
    await expect(page).toHaveURL(/\/en\/settings/);
  });

  test("Previously brand link returns to the chat page", async ({ page }) => {
    await page.goto("/en/settings");
    await page.click('header a[href="/en"]');
    await expect(page).toHaveURL(/\/en$/);
  });

  test("header exposes the GitHub link", async ({ page }) => {
    await page.goto("/en");
    const github = page.locator(
      'header a[href="https://github.com/previously-lab/agent"]',
    );
    await expect(github).toBeVisible();
  });
});
