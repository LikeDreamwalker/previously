import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_HOME } from "./env";

// The settings Client section (src/components/settings/client-section.tsx)
// self-gates on GET /api/client/status and persists via POST /api/client/config
// to PREVIOUSLY_HOME/config.json — this spec asserts the real on-disk write
// against the isolated e2e home (see tests/e2e/env.ts).
test.describe("Settings — Client section", () => {
  test("saves a bridge brain selection to PREVIOUSLY_HOME/config.json", async ({
    page,
  }) => {
    await page.goto("/en/settings");

    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Client", exact: true }),
    });
    await expect(section).toBeVisible();

    // Brain → Subscription bridge reveals the agent picker.
    const brainSelect = section.locator("select").first();
    await brainSelect.selectOption("bridge");
    const agentSelect = section.locator("select").nth(1);
    await expect(agentSelect).toBeVisible();

    // Wait for PATH detection to settle so option enabled/disabled states are
    // final (probes are timeout-bounded, worst case a few seconds).
    await expect(
      section.getByText("Detecting local agents"),
    ).toBeHidden({ timeout: 30_000 });

    // Pick the first enabled agent — never assume a specific CLI is installed.
    // (The currently-selected option stays enabled even when undetected, so at
    // least one is always selectable.)
    const enabledOptions = agentSelect.locator("option:not([disabled])");
    let chosenAgent: string | null = null;
    if ((await enabledOptions.count()) > 0) {
      chosenAgent = await enabledOptions.first().getAttribute("value");
      await agentSelect.selectOption(chosenAgent!);
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

  // The "Agent parameters" block renders one model/effort row per locally
  // INSTALLED CLI (client-section.tsx, installedAgents) — never assume a
  // specific CLI is present; work with whatever rows render.
  test("saves a per-agent default model to PREVIOUSLY_HOME/config.json", async ({
    page,
  }) => {
    await page.goto("/en/settings");

    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Client", exact: true }),
    });
    await expect(section).toBeVisible();

    // Wait for PATH detection to settle — the params rows render only once
    // the probe lands (probes are timeout-bounded, worst case a few seconds).
    await expect(
      section.getByText("Detecting local agents"),
    ).toBeHidden({ timeout: 30_000 });

    const paramsHeading = section.getByRole("heading", {
      name: "Agent parameters",
      exact: true,
    });
    if (!(await paramsHeading.isVisible())) {
      // No agent CLI installed on this machine — the block is empty by design.
      test.skip(true, "no bridge agent CLI installed — no params rows render");
    }

    // First rendered row: the font-mono span holds the agent name, the row's
    // only <input> is the model field (effort is a <select>).
    const block = paramsHeading.locator("xpath=..");
    const firstRow = block.locator("span.font-mono").first().locator("xpath=..");
    const agentName = (await block.locator("span.font-mono").first().textContent())?.trim();
    expect(agentName).toBeTruthy();

    const modelInput = firstRow.locator("input").first();
    await modelInput.fill("e2e-default-model");

    await section
      .getByRole("button", { name: "Save client config" })
      .click();
    // Exact text — see the brain test above for why a loose match is unsafe.
    await expect(section.getByText("Saved ✓", { exact: true })).toBeVisible();

    // Real persistence to the client home on disk.
    const raw = JSON.parse(
      await readFile(path.join(E2E_HOME, "config.json"), "utf8"),
    ) as { agents?: Record<string, { model?: string }> };
    expect(raw.agents?.[agentName!]?.model).toBe("e2e-default-model");
  });
});
