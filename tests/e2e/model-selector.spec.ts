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

  // Thinking is always ON at low effort (pinned server-side in
  // start-turn.ts) — the effort cycle button (Zap icon) and the thinking
  // switch row were removed from the chat UI. These are negative assertions
  // against locale-independent hooks: the lucide icon class and the ARIA
  // role of the Base UI Switch.
  test("locked thinking/effort UX — no effort button, no thinking switch", async ({
    page,
  }) => {
    await page.goto("/en");

    // (a) No effort cycle button anywhere in the chat input area.
    const chatInput = page.locator(".rounded-2xl", {
      has: page.getByPlaceholder("Send a message..."),
    });
    await expect(chatInput).toBeVisible();
    await expect(chatInput.locator("svg.lucide-zap")).toHaveCount(0);

    // (b) The model selector popover has no thinking switch row.
    const trigger = page.getByRole("button", {
      name: /Claude \(subscription bridge\)/,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const popover = page.locator('[data-slot="popover-content"]');
    await expect(
      popover.getByText("Subscription Bridge", { exact: true }),
    ).toBeVisible();
    await expect(popover.locator('[role="switch"]')).toHaveCount(0);
    await expect(popover.getByText("Thinking", { exact: true })).toHaveCount(0);
  });
});
