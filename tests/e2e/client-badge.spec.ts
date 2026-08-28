import { test, expect } from "@playwright/test";

// The client-mode header badge (src/components/layout/client-badge.tsx) gates
// at runtime on GET /api/version — the e2e webServer runs with
// PREVIOUSLY_MODE=client, so the badge must render. The cloud-mode negative
// (badge absent, /api/client/* 404s) is covered by the vitest route tests
// (tests/app/api/client.test.ts) — a second webServer with different env would
// double the boot cost for one assertion.
test.describe("Client badge", () => {
  test("shows the Local badge in the header and its popover copy", async ({
    page,
  }) => {
    await page.goto("/en");

    const badge = page
      .locator("header")
      .getByRole("button", { name: "Local", exact: true });
    await expect(badge).toBeVisible();

    await badge.click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover.getByText("Running locally")).toBeVisible();
    await expect(popover.getByText(/Kernel version/)).toBeVisible();
  });
});
