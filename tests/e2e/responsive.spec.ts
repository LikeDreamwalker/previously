import { test, expect } from "@playwright/test";

// The app's mobile layout: the top AppHeader stays visible (brand + icon-only
// nav links), the chat page has no horizontal overflow, and the chat input is
// usable at phone widths. There is no sidebar drawer.
test.describe("Responsive - Mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no horizontal scroll on the chat page", async ({ page }) => {
    await page.goto("/en");
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("header stays visible with brand and nav links", async ({ page }) => {
    await page.goto("/en");
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator('header a[href="/en"]')).toBeVisible();
    await expect(
      page.locator('header a[href="https://previously.ldwid.com/en/docs"]'),
    ).toBeVisible();
    await expect(page.locator('header a[href="/en/settings"]')).toBeVisible();
  });

  test("chat input is usable on mobile", async ({ page }) => {
    await page.goto("/en");
    const input = page.locator("textarea");
    await expect(input).toBeEnabled();
    // pressSequentially (not fill) — real key events that a React controlled
    // textarea's onChange reliably handles on WebKit, unlike fill's one-shot value.
    await input.pressSequentially("hello");
    await expect(input).toHaveValue("hello");
  });
});
