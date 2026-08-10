import { test, expect } from "@playwright/test";

// Current routes: chat lives at the locale root (/), with docs and settings as
// the only sub-routes. Navigation is the top AppHeader (Previously / GitHub /
// Docs / Settings) — there is no sidebar. Header link hrefs are locale-prefixed
// (/en/docs, ...), so tests select them by href.
const ROUTES = ["/", "/docs", "/settings"] as const;

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

  test("chat page shows the hero and a chat input", async ({ page }) => {
    await page.goto("/en");
    await expect(page.getByText("Previously on", { exact: true })).toBeVisible();
    await expect(page.locator("textarea")).toBeVisible();
  });

  test("settings page renders the settings form", async ({ page }) => {
    await page.goto("/en/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.locator("input").first()).toBeVisible();
  });

  test("docs page renders content", async ({ page }) => {
    await page.goto("/en/docs");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("header Docs link navigates to docs", async ({ page }) => {
    await page.goto("/en");
    await page.click('header a[href="/en/docs"]');
    await expect(page).toHaveURL(/\/en\/docs/);
  });

  test("header Settings link navigates to settings", async ({ page }) => {
    await page.goto("/en");
    await page.click('header a[href="/en/settings"]');
    await expect(page).toHaveURL(/\/en\/settings/);
  });

  test("Previously brand link returns to the chat page", async ({ page }) => {
    await page.goto("/en/docs");
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
