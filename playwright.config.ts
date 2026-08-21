import { defineConfig, devices } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_HOME,
  E2E_MEMORY_ROOT,
  E2E_PORT,
} from "./tests/e2e/env";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  // Turbopack dev-server compiles routes on first hit — be generous.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // prepare-env wipes the isolated state roots, generate-identity mirrors the
    // predev hook, then the dev server boots in client + subscription-bridge
    // mode against throwaway temp dirs — never the developer's ~/.previously.
    command: `node tests/e2e/prepare-env.mjs && node scripts/generate-identity.mjs && pnpm exec next dev --turbopack --port ${E2E_PORT}`,
    port: E2E_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      PREVIOUSLY_MODE: "client",
      PREVIOUSLY_BRAIN: "bridge",
      PREVIOUSLY_HOME: E2E_HOME,
      MEMORY_ROOT: E2E_MEMORY_ROOT,
    },
  },
});
