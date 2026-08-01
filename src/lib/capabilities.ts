/**
 * Global capability checks — the single source of truth for "what can this
 * app do right now?"
 *
 * Every engineering-side check (tool executors, server components, API routes,
 * config loaders) should import from here instead of reading process.env
 * directly. The AI model layer does NOT import this — it learns about
 * limitations through tool-executor rejections returned as tool results.
 *
 * Data-source logic delegates to @/lib/data-source/resolve — this module only
 * answers capability questions derived from that source.
 */

import { resolveDataSource, isWritable } from "@/lib/data-source/resolve";

// ─── Core checks ──────────────────────────────────────────────────────────

/** Is a specific model provider's API key configured? */
export function isProviderConfigured(provider: string): boolean {
  switch (provider) {
    case "deepseek":
      return !!process.env.DEEPSEEK_API_KEY;
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    default:
      return false;
  }
}

/** Provider names whose API key is configured, in a stable order. */
export function getConfiguredProviders(): string[] {
  const providers: string[] = [];
  if (process.env.DEEPSEEK_API_KEY) providers.push("deepseek");
  if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
  if (process.env.OPENAI_API_KEY) providers.push("openai");
  return providers;
}

/** Can the app make AI calls? Any provider key is configured. */
export function isAIConfigured(): boolean {
  return getConfiguredProviders().length > 0;
}

/**
 * Is the app in read-only demo mode?
 * True when the resolved data source is "demo".
 */
export function isDemo(): boolean {
  return resolveDataSource() === "demo";
}

/**
 * Can the app persist data?
 * True when the data source supports writes (local or github). The inverse
 * of demo mode.
 */
export function canWrite(): boolean {
  return isWritable();
}

// ─── Centralized repo identity ────────────────────────────────────────────

/**
 * GitHub repository identity, resolved once from environment.
 * Replaces the duplicated `getRepoConfig()` pattern that existed in 8+ files.
 */
export function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

// ─── URLs ─────────────────────────────────────────────────────────────────

/** Deployment guide — shown to users who need to set up their own instance. */
export const DEPLOY_GUIDE_URL = "https://previously.ldwid.com/docs/deployment";
