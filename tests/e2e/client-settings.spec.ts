import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_HOME } from "./env";

// The settings Client block (src/components/settings/client-section.tsx) is
// gated server-side on isClientMode() (with a runtime /api/client/status 404
// self-hide as fallback) and persists via POST /api/client/config to
// PREVIOUSLY_HOME/config.json — this spec asserts the real on-disk write
// against the isolated e2e home (see tests/e2e/env.ts). It runs in client
// mode, so the block always renders.
//
// Anchors: the block root carries data-slot="settings-client". All selects
// are ui/select (Base UI) — trigger role="combobox", options role="option" in
// a listbox popup portaled to <body> (click trigger → click option; disabled
// items carry [data-disabled]). The engine switcher is ui/tabs (role="tab").
test.describe("Settings — Client section", () => {
  // fullyParallel is on globally, but these tests share one on-disk
  // config.json in E2E_HOME — concurrent saves would last-write-wins race
  // each other's assertions. Serial within this describe; other files stay
  // parallel.
  test.describe.configure({ mode: "serial" });
  test("saves a bridge brain selection to PREVIOUSLY_HOME/config.json", async ({
    page,
  }) => {
    await page.goto("/en/settings");

    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();

    // Engine → Local agent reveals the agent picker.
    await section.getByRole("tab", { name: /Local agent/ }).click();

    // Wait for PATH detection to settle so option enabled/disabled states are
    // final (probes are timeout-bounded, worst case a few seconds).
    await expect(
      section.getByText("Detecting local agents"),
    ).toBeHidden({ timeout: 30_000 });

    // The agent picker is the only combobox in the local-agent panel. Base UI
    // renders the option list in a popup portaled to <body>.
    const agentPicker = section.getByRole("combobox").first();
    await agentPicker.click();

    // Base UI mounts the popup items asynchronously (a positioning pass after
    // the trigger click) — wait for the first option before counting, or the
    // enabled-option count races the mount and comes back 0.
    await page.locator('[role="option"]').first().waitFor();

    // Pick the first enabled agent — never assume a specific CLI is installed.
    // (The currently-selected option stays enabled even when undetected, so at
    // least one is always selectable.)
    const enabledOptions = page.locator('[role="option"]:not([data-disabled])');
    let chosenAgent: string | null = null;
    if ((await enabledOptions.count()) > 0) {
      const label = ((await enabledOptions.first().textContent()) ?? "").trim();
      // An enabled-but-undetected option reads "claude (not installed)".
      chosenAgent = label.replace(/ \(not installed\)$/, "");
      await enabledOptions.first().click();
    } else {
      await page.keyboard.press("Escape");
    }

    await section
      .getByRole("button", { name: "Save client config" })
      .click();
    // Exact text — the section description contains "…saved to the client
    // home…", which a loose substring match would pass on before the POST
    // completes. The success copy only renders after a 200 + on-disk write.
    await expect(section.getByText("Saved ✓", { exact: true })).toBeVisible();

    // The point of this spec: real persistence to the client home on disk.
    const raw = JSON.parse(
      await readFile(path.join(E2E_HOME, "config.json"), "utf8"),
    ) as { brain?: { type?: string; agent?: string } };
    expect(raw.brain?.type).toBe("bridge");
    if (chosenAgent) {
      expect(raw.brain?.agent).toBe(chosenAgent);
    } else {
      expect(["claude", "codex", "kimi"]).toContain(raw.brain?.agent);
    }
  });

  // The per-agent model/effort tuning UI was removed (v0.9 settings
  // simplification) — `agents` in config.json stays API-compatible but has no
  // settings-UI surface, so there is no params persistence test anymore.

  // The BYOK form (user's own API key) posts the `byok` section through the
  // same endpoint — the assertion is the on-disk write only; no real provider
  // API call happens anywhere in this flow.
  test("saves a BYOK config to PREVIOUSLY_HOME/config.json", async ({
    page,
  }) => {
    await page.goto("/en/settings");

    const section = page.locator('[data-slot="settings-client"]');
    await expect(section).toBeVisible();

    // Engine → Your own API key reveals the BYOK form.
    await section.getByRole("tab", { name: /Your own API key/ }).click();

    // Provider keeps its default (deepseek — a preset, so no baseUrl row
    // renders); the provider control is a ui/select combobox we don't touch.
    await section.locator('input[type="password"]').fill("sk-e2e-byok");
    // The model input is the form's last text input (no baseUrl for presets).
    await section.getByPlaceholder("e.g. deepseek-chat").fill("e2e-byok-model");

    await section
      .getByRole("button", { name: "Save client config" })
      .click();
    // Exact text — see the brain test above for why a loose match is unsafe.
    await expect(section.getByText("Saved ✓", { exact: true })).toBeVisible();

    // Real persistence to the isolated client home on disk.
    const raw = JSON.parse(
      await readFile(path.join(E2E_HOME, "config.json"), "utf8"),
    ) as { byok?: { provider?: string; apiKey?: string; model?: string } };
    expect(raw.byok).toEqual({
      provider: "deepseek",
      apiKey: "sk-e2e-byok",
      model: "e2e-byok-model",
    });
  });
});
