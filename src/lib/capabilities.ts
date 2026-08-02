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

/**
 * Known AI provider → API key env var. Covers the common OpenAI-compatible
 * providers (Kimi, Qwen, Mistral, xAI, ...) plus DeepSeek/Anthropic. This is
 * the coarse "can we make any AI call" gate; the full dynamic catalog (which
 * may include providers beyond this list) is resolved in @/lib/models/catalog.
 */
const PROVIDER_ENV: Record<string, string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  alibaba: ["DASHSCOPE_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
};

/** Is a specific model provider's API key configured? */
export function isProviderConfigured(provider: string): boolean {
  const keys = PROVIDER_ENV[provider];
  return keys ? keys.some((k) => !!process.env[k]) : false;
}

/** Provider names whose API key is configured, in a stable order. */
export function getConfiguredProviders(): string[] {
  return Object.entries(PROVIDER_ENV)
    .filter(([, keys]) => keys.some((k) => !!process.env[k]))
    .map(([provider]) => provider);
}

/** Can the app make AI calls? Any known provider key is configured. */
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
