/**
 * Server-side config loader. Reads `memory/user/config.json` at request time
 * via the same GitHub / local-fs dual channel as the user profile. If the file
 * is missing or unparseable, returns the full defaults — no runtime error.
 */
import { readFile } from "@/lib/tools/readFile";
import { readFileLocal } from "@/lib/tools/local-fs";
import { readFileDemo } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import { mergeConfig, DEFAULTS } from "./defaults";
import { demoModelLock } from "@/lib/demo/model-lock";
import type { UserConfig } from "./types";

const CONFIG_PATH = "memory/user/config.json";

const SOURCE = resolveDataSource();

async function readRaw(): Promise<string | null> {
  try {
    if (SOURCE === "demo") return await readFileDemo(CONFIG_PATH);
    if (SOURCE === "github") {
      const { owner, repo } = getRepoConfig();
      return await readFile(CONFIG_PATH, repo, owner);
    }
    return await readFileLocal(CONFIG_PATH);
  } catch {
    return null;
  }
}

let cached: UserConfig | null = null;
let cacheTtl = 0;

/**
 * Drop the in-memory config cache. Called after a config WRITE so the next
 * read reflects the just-saved values instead of serving stale for the TTL.
 */
export function invalidateUserConfigCache(): void {
  cached = null;
  cacheTtl = 0;
}

/**
 * Clamp the model section to the demo lock when in demo mode, so the client
 * seeds its UI with the values the server will actually enforce (startTurn
 * ignores per-request overrides in demo mode).
 */
function applyDemoLock(config: UserConfig): UserConfig {
  const lock = demoModelLock();
  if (!lock) return config;
  return {
    ...config,
    model: {
      provider: lock.model,
      thinking: lock.thinking,
      reasoningEffort: lock.effort,
    },
  };
}

/**
 * Load the user config, merging any present fields onto defaults. Cached in
 * memory for 60 seconds so repeated reads within a single request stream don't
 * re-fetch from disk / GitHub.
 */
export async function loadUserConfig(): Promise<UserConfig> {
  const now = Date.now();
  if (cached && now < cacheTtl) return cached;

  const raw = await readRaw();
  if (!raw) {
    cached = applyDemoLock(DEFAULTS);
    cacheTtl = now + 60_000;
    return cached;
  }

  try {
    const parsed = JSON.parse(raw);
    cached = applyDemoLock(mergeConfig(parsed));
    cacheTtl = now + 60_000;
    return cached;
  } catch {
    cached = applyDemoLock(DEFAULTS);
    cacheTtl = now + 60_000;
    return cached;
  }
}
