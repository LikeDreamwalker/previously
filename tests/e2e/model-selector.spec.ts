import { test, expect } from "@playwright/test";

// The chat model selector (src/components/chat/model-selector.tsx) fetches
// /api/models; in client + PREVIOUSLY_BRAIN=bridge mode it must list a
// "Subscription Bridge" group with one bridge/<agent> entry per known CLI
// (src/lib/models/registry.ts). Assertions use brand/English strings only —
// locale-independent. The seeded user config (tests/e2e/prepare-env.mjs) pins
// the current model to bridge/claude, so the trigger label is deterministic.
test.describe("Model selector — subscription bridge group", () => {
  test("lists claude/codex/kimi bridge entries", async ({ page }) => {
    await page.goto("/en");

    const trigger = page.getByRole("button", {
      name: /Claude \(subscription bridge\)/,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const popover = page.locator('[data-slot="popover-content"]');
    await expect(
      popover.getByText("Subscription Bridge", { exact: true }),
    ).toBeVisible();

    for (const agent of ["Claude", "Codex", "Kimi"]) {
      await expect(
        popover.getByRole("button", {
          name: new RegExp(`${agent} \\(subscription bridge\\)`),
        }),
      ).toBeVisible();
    }
    // Exactly three bridge entries — one per known agent CLI.
    await expect(
      popover.locator("button").filter({ hasText: "(subscription bridge)" }),
    ).toHaveCount(3);
  });
});
