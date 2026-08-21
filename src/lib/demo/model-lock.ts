/**
 * Demo-mode model lock.
 *
 * PUBLIC demo deployments (the maintainer's, serving anonymous traffic on the
 * maintainer's API key) pin the model and thinking intensity server-side so
 * visitors can't switch to a pricier tier (V4 Pro) or crank reasoning effort.
 *
 * A self-hosted deployment can also land on the demo data source (prod with no
 * GITHUB_TOKEN auto-detects to demo) — indistinguishable from the public demo
 * in code, and there the key is the user's own. So the lock is OPT-IN: it only
 * activates when STORAGE resolves to "demo" AND DEMO_LOCK is truthy ("1",
 * "true", "yes"). Self-hosted deployments leave it unset and stay unlocked.
 *
 * The lock is applied in three places:
 *   - loadUserConfig (config/loader) — the client SEES the locked values
 *   - GET /api/models — the selector only lists the locked model (and hides)
 *   - startTurn (api/chat/start-turn) — the authoritative enforcement; the
 *     per-request client overrides are ignored while locked
 *
 * Defaults target the cheapest vision-capable DeepSeek tier so demo image
 * uploads work; override with DEMO_MODEL / DEMO_EFFORT when DeepSeek retires
 * the exp id.
 */
import { resolveDataSource } from "@/lib/data-source/resolve";

export const DEMO_LOCK_DEFAULT_MODEL = "deepseek-v4-flash-vision-exp";

export interface DemoModelLock {
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high";
}

/** The active lock, or null when not in demo mode / lock not enabled. */
export function demoModelLock(): DemoModelLock | null {
  if (resolveDataSource() !== "demo") return null;
  const enabled = process.env.DEMO_LOCK;
  if (enabled !== "1" && enabled !== "true" && enabled !== "yes") return null;
  const envEffort = process.env.DEMO_EFFORT;
  return {
    model: process.env.DEMO_MODEL || DEMO_LOCK_DEFAULT_MODEL,
    thinking: true,
    effort: envEffort === "medium" || envEffort === "high" ? envEffort : "low",
  };
}
