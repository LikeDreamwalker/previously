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
 * Load the user config, merging any present fields onto defaults. Cached in
 * memory for 60 seconds so repeated reads within a single request stream don't
 * re-fetch from disk / GitHub.
 */
export async function loadUserConfig(): Promise<UserConfig> {
  const now = Date.now();
  if (cached && now < cacheTtl) return cached;

  const raw = await readRaw();
  if (!raw) {
    cached = DEFAULTS;
    cacheTtl = now + 60_000;
    return cached;
  }

  try {
    const parsed = JSON.parse(raw);
    cached = mergeConfig(parsed);
    cacheTtl = now + 60_000;
    return cached;
  } catch {
    cached = DEFAULTS;
    cacheTtl = now + 60_000;
    return cached;
  }
}
