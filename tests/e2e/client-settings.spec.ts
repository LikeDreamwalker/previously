import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_HOME } from "./env";

// The settings Client block (src/components/settings/client-section.tsx) is
// gated server-side on isClientMode() (with a runtime /api/client/status 404
// self-hide as fallback) and AUTO-SAVES via POST /api/client/config to
// PREVIOUSLY_HOME/config.json (a sonner toast reports each outcome) — this
// spec asserts the real on-disk write against the isolated e2e home (see
// tests/e2e/env.ts). It runs in client mode, so the block always renders.
//
// Anchors: the block root carries data-slot="settings-client". All selects
// are ui/select (Base UI) — trigger role="combobox", options role="option" in
// a listbox popup portaled to <body> (click trigger → wait for the options to
// mount → click option). The engine picker is the section's first combobox.
test.describe("Settings — Client section", () => {
  // fullyParallel is on globally, but these tests share one on-disk
  // config.json in E2E_HOME — concurrent saves would last-write-wins race
  // each other's assertions. Serial within this describe; other files stay
  // parallel.
  test.describe.configure({ mode: "serial" });

  /** Open a Base UI select and click the named option (items mount async). */
  async function pickOption(
    page: import("@playwright/test").Page,
    combobox: import("@playwright/test").Locator,
    name: string | RegExp,
  ) {
    await combobox.click();
    const option = page.getByRole("option", { name });
    await option.waitFor();
    await option.click();
  }

  const savedToast = (page: import("@playwright/test").Page) =>
    page.locator("[data-sonner-toast]").getByText("Saved ✓", { exact: true });

  test("auto-saves the engine switch to PREVIOUSLY_HOME/config.json", async ({
    page,
  }) => {
    await page.goto("/en/settings");

    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();

    // The engine picker is the section's first combobox. Switch bridge → byok
    // (clears the brain) and back (writes the bridge brain) — the round trip
    // needs no assumptions about which agent CLIs are installed.
    const enginePicker = section.getByRole("combobox").first();
    await pickOption(page, enginePicker, /Your own API key/);
    await pickOption(page, enginePicker, /Local agent/);

    // Auto-save toast — the POST (and on-disk write) completed before it
    // renders, so no extra polling is needed.
    await expect(savedToast(page).first()).toBeVisible();

    // The point of this spec: real persistence to the client home on disk.
    const raw = JSON.parse(
      await readFile(path.join(E2E_HOME, "config.json"), "utf8"),
    ) as { brain?: { type?: string; agent?: string } };
    expect(raw.brain?.type).toBe("bridge");
    expect(["claude", "codex", "kimi"]).toContain(raw.brain?.agent);
  });

  // The per-agent model/effort tuning UI was removed (v0.9 settings
  // simplification) — `agents` in config.json stays API-compatible but has no
  // settings-UI surface, so there is no params persistence test anymore.

  // The BYOK form (user's own API key) auto-saves the `byok` section through
  // the same endpoint (debounced) — the assertion is the on-disk write only;
  // no real provider API call happens anywhere in this flow.
  test("auto-saves a BYOK config to PREVIOUSLY_HOME/config.json", async ({
    page,
  }) => {
    await page.goto("/en/settings");

    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();

    // Engine → Your own API key reveals the BYOK form.
    const enginePicker = section.getByRole("combobox").first();
    await pickOption(page, enginePicker, /Your own API key/);

    // Provider keeps its default (deepseek — a preset, so no baseUrl row
    // renders); the provider control is a ui/select combobox we don't touch.
    await section.locator('input[type="password"]').fill("sk-e2e-byok");
    await section.getByPlaceholder("e.g. deepseek-chat").fill("e2e-byok-model");

    // The debounced auto-save fires ~800ms after the last edit — poll the
    // on-disk file instead of the toast (the engine switch's own toast is
    // already visible and would race the debounce).
    await expect
      .poll(
        async () => {
          const raw = JSON.parse(
            await readFile(path.join(E2E_HOME, "config.json"), "utf8"),
          ) as { byok?: unknown };
          return raw.byok ?? null;
        },
        { timeout: 10_000 },
      )
      .toEqual({
        provider: "deepseek",
        apiKey: "sk-e2e-byok",
        model: "e2e-byok-model",
      });
  });
});
