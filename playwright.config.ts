import { defineConfig, devices } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_HOME,
  E2E_MEMORY_ROOT,
  E2E_PORT,
} from "./tests/e2e/env";

/**
 * Packaged-artifact mode: when E2E_EXTERNAL_BASE_URL is set, specs run against
 * an already-running server (e.g. a standalone kernel installed and started by
 * the published previously-client npm package) instead of booting the dev
 * server. Only packaged.spec.ts is expected to run in this mode; the other
 * specs assume the dev-server webServer env and its seeded E2E_HOME.
 */
const externalBaseURL = process.env.E2E_EXTERNAL_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  // One worker: every spec shares the single dev server and its isolated
  // MEMORY_ROOT, and the memory-viz specs seed slice data that would race the
  // other specs' arrival/briefing assertions under parallel workers.
  workers: 1,
  reporter: "list",
  // Turbopack dev-server compiles routes on first hit — be generous.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: externalBaseURL ?? E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  ...(externalBaseURL
    ? {}
    : {
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
            // .env.local must not leak a datasource override (e.g. a
            // developer's STORAGE=demo) into the seeded local fixture.
            STORAGE: "local",
          },
        },
      }),
});
