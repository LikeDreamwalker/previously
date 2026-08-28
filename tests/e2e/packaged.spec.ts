import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Packaged-artifact E2E: runs against an ALREADY-RUNNING standalone kernel
// (installed and started by the published previously-client npm package), not
// the dev-server webServer. Select it with E2E_EXTERNAL_BASE_URL (the config
// switches baseURL and skips webServer when set); E2E_EXTERNAL_HOME points at
// the server's PREVIOUSLY_HOME so on-disk config.json writes can be asserted;
// E2E_BYOK_API_KEY is the real DeepSeek key for the BYOK engine tests (never
// logged — assertions compare against it in-process and report booleans).
//
// Selector anchors mirror client-settings.spec.ts / model-selector.spec.ts:
// settings block [data-slot="settings-client"], Base UI combobox/options,
// chat model popover [data-slot="popover-content"], messages carry
// [data-slot="message"][data-align="start"|"end"], and the chat error surface
// is the red border-destructive banner (chat-section.tsx ErrorBanner).
test.skip(
  !process.env.E2E_EXTERNAL_BASE_URL,
  "packaged-artifact spec — set E2E_EXTERNAL_BASE_URL to an already-running standalone kernel",
);

test.describe.configure({ mode: "serial" });

const EXTERNAL_HOME = process.env.E2E_EXTERNAL_HOME;
const BYOK_API_KEY = process.env.E2E_BYOK_API_KEY;
const BYOK_MODEL = "deepseek-chat";
const PROMPT = "Reply with exactly: OK";

/** Open a Base UI select and click the named option (items mount async). */
async function pickOption(
  page: Page,
  combobox: import("@playwright/test").Locator,
  name: string | RegExp,
) {
  await combobox.click();
  const option = page.getByRole("option", { name });
  await option.waitFor();
  await option.click();
}

/** The chat toolbar's model trigger — the only toolbar button whose
 *  accessible name is the current model's label. */
async function selectChatModel(page: Page, name: RegExp) {
  const chatInput = page.locator(".rounded-2xl", {
    has: page.getByPlaceholder("Send a message..."),
  });
  const trigger = chatInput.getByRole("button", {
    name: /subscription bridge|BYOK|deepseek/i,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const popover = page.locator('[data-slot="popover-content"]');
  const option = popover.getByRole("button", { name });
  await option.waitFor();
  await option.click();
  // The popover is uncontrolled — selecting an option does not close it.
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
}

/** Send PROMPT, wait for the turn to finish, assert an OK reply and no
 *  error UI. The textarea is disabled while a turn streams and re-enabled
 *  when it settles (success OR failure — failures are caught by the banner
 *  assertion right after). */
async function sendPromptAndExpectOk(page: Page) {
  const input = page.getByPlaceholder("Send a message...");
  await input.fill(PROMPT);
  await input.press("Enter");

  await expect(input).toBeDisabled({ timeout: 15_000 });
  await expect(input).toBeEnabled({ timeout: 120_000 });

  // The red chat-error banner (chat-section.tsx), sonner error toasts, and
  // the inline turn-failure phase (terminal data-phase "turnError").
  await expect(page.locator('[class*="border-destructive"]')).toHaveCount(0);
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]'),
  ).toHaveCount(0);
  await expect(
    page.getByText(/turn failed with an unexpected error/i),
  ).toHaveCount(0);

  // Assistant bubbles are align="start" (the user's own prompt, which also
  // contains "OK", is align="end" and excluded); the reply prose lives in
  // MarkdownRenderer blocks (.typeset-chat) — per-block matching avoids the
  // card text and the reply fusing into one word in the joined textContent
  // ("…no updates needed" + "OK" → "neededOK", which defeats \bOK\b).
  const replyBlocks = await page
    .locator('[data-slot="message"][data-align="start"] .typeset-chat')
    .allTextContents();
  expect(
    replyBlocks.some((t) => /\bOK\b/.test(t)),
    `expected an assistant reply block containing "OK", got: ${JSON.stringify(replyBlocks.map((t) => t.slice(0, 200)))}`,
  ).toBe(true);
}

test.describe("Packaged standalone kernel", () => {
  test("renders /en and /en/settings with no missing assets", async ({
    page,
  }) => {
    const bad: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
    });

    await page.goto("/en");
    await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Substantive content, not a blank shell.
    const homeText = await page.locator("body").innerText();
    expect(homeText.trim().length).toBeGreaterThan(50);

    await page.goto("/en/settings");
    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();
    await page.waitForLoadState("networkidle");
    const settingsText = await page.locator("body").innerText();
    expect(settingsText.trim().length).toBeGreaterThan(50);

    // Standalone packaging must not lose static assets / i18n chunks.
    expect(bad, `responses with status >= 400:\n${bad.join("\n")}`).toEqual([]);
  });

  test("BYOK form auto-save lands in config.json and registers the model", async ({
    page,
    request,
  }) => {
    test.skip(!EXTERNAL_HOME, "E2E_EXTERNAL_HOME is required");
    test.skip(!BYOK_API_KEY, "E2E_BYOK_API_KEY is required");

    await page.goto("/en/settings");
    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();

    // Engine → Your own API key reveals the BYOK form; provider keeps its
    // deepseek default (a preset, so no baseUrl row renders).
    const enginePicker = section.getByRole("combobox").first();
    await pickOption(page, enginePicker, /Your own API key/);
    await section.locator('input[type="password"]').fill(BYOK_API_KEY!);
    await section.getByPlaceholder("e.g. deepseek-chat").fill(BYOK_MODEL);

    // The debounced (~800ms) auto-save POSTs /api/client/config; assert the
    // real on-disk write. Compared in-process so the key never reaches logs.
    await expect
      .poll(
        async () => {
          try {
            const raw = JSON.parse(
              await readFile(path.join(EXTERNAL_HOME!, "config.json"), "utf8"),
            ) as { byok?: { provider?: string; apiKey?: string; model?: string } };
            const b = raw.byok;
            return (
              b?.provider === "deepseek" &&
              b?.apiKey === BYOK_API_KEY &&
              b?.model === BYOK_MODEL
            );
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // POST /api/client/config resets the catalog cache — the BYOK entry must
    // appear without a restart.
    await expect
      .poll(
        async () => {
          const res = await request.get("/api/models");
          if (!res.ok()) return [] as string[];
          const body = (await res.json()) as { models: Array<{ id: string }> };
          return body.models.map((m) => m.id);
        },
        { timeout: 10_000 },
      )
      .toContain(`byok/${BYOK_MODEL}`);
  });

  test("BYOK model completes a real chat turn", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!BYOK_API_KEY, "E2E_BYOK_API_KEY is required");

    await page.goto("/en");
    await selectChatModel(page, new RegExp(`${BYOK_MODEL} \\(BYOK\\)`));
    await sendPromptAndExpectOk(page);
  });

  test("bridge model (kimi) completes a real chat turn", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!EXTERNAL_HOME, "E2E_EXTERNAL_HOME is required");

    // Engine back to Local agent — after the BYOK detour the stored brain is
    // null, so the agent picker falls back to its "claude" default; pin kimi
    // explicitly and verify the on-disk brain before chatting.
    await page.goto("/en/settings");
    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();
    const enginePicker = section.getByRole("combobox").first();
    await pickOption(page, enginePicker, /Local agent/);
    await pickOption(page, section.getByRole("combobox").nth(1), /^kimi$/);

    await expect
      .poll(
        async () => {
          try {
            const raw = JSON.parse(
              await readFile(path.join(EXTERNAL_HOME!, "config.json"), "utf8"),
            ) as { brain?: { type?: string; agent?: string } };
            return raw.brain?.type === "bridge" && raw.brain?.agent === "kimi";
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.goto("/en");
    await selectChatModel(page, /Kimi \(subscription bridge\)/);
    await sendPromptAndExpectOk(page);
  });
});
