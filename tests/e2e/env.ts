import os from "node:os";
import path from "node:path";

/**
 * Shared constants for the Playwright E2E setup — imported by
 * playwright.config.ts (webServer env) and by specs that need to inspect the
 * isolated state roots. tests/e2e/prepare-env.mjs (plain JS, run by node
 * inside the webServer command chain) receives the same dirs via env vars.
 */

/** Dedicated port so e2e never collides with a developer's `pnpm dev` (3000). */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/**
 * Isolated per-run state roots under the OS temp dir — the e2e kernel must
 * never touch the developer's real ~/.previously or the repo's memory/.
 * Deterministic paths (not mkdtemp) so spec workers resolve the same dirs the
 * webServer env got; prepare-env.mjs wipes and recreates them on every boot.
 */
export const E2E_HOME = path.join(os.tmpdir(), "previously-e2e", "home");
export const E2E_MEMORY_ROOT = path.join(os.tmpdir(), "previously-e2e", "memory");
