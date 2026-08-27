"use server";

/**
 * Server action: persist user config to `memory/user/config.json`.
 * Accepts a partial config — only the fields the user touched in Settings.
 * Re-validates the home page so the agent picks up new values on next request.
 */
import { revalidatePath } from "next/cache";
import { writeFile } from "@/lib/tools/writeFile";
import { writeFileLocal } from "@/lib/tools/local-fs";
import { getRepoConfig, isDemo } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getMemoryRoot } from "@/lib/whitelist";
import { commitPaths, isGitRepo } from "@/lib/episodic/local-git";
import { DEFAULTS, mergeConfigOverrides } from "./defaults";
import { loadUserConfig, invalidateUserConfigCache } from "./loader";
import type { UserConfig, UserConfigOverrides } from "./types";

const CONFIG_PATH = "memory/user/config.json";

/** Client-safe view of the current config (model ids, limits — no secrets). */
export async function getUserConfig(): Promise<UserConfig> {
  return loadUserConfig();
}

export async function saveUserConfig(
  overrides: UserConfigOverrides,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Demo mode: config writes are not persisted.
    if (isDemo()) {
      return { ok: false, error: "Config changes are not saved in demo mode. Deploy your own instance to customize settings." };
    }

    const current = await loadUserConfig();
    const merged = mergeConfigOverrides(current, overrides);

    const json = JSON.stringify(merged, null, 2);

    // Branch on the data SOURCE, not on canWrite() — canWrite() is true for
    // both local and github, which used to send local writes down the GitHub
    // path and silently fail. Local dev writes to disk; GitHub mode commits.
    if (resolveDataSource() === "github") {
      const { owner, repo } = getRepoConfig();
      await writeFile(CONFIG_PATH, json, repo, owner);
    } else {
      await writeFileLocal(CONFIG_PATH, json);
      // Best-effort git ledger, mirroring the GitHub path's commit — a no-op
      // unless the memory root is a git repo; never throws (see local-git).
      const memoryRoot = getMemoryRoot();
      if (isGitRepo(memoryRoot)) {
        await commitPaths(memoryRoot, ["user/config.json"], "Update user/config.json");
      }
    }

    // Drop the loader's parsed-config cache so the next read (and the RSC
    // preload on the home page) reflects the just-saved values, not a stale
    // copy for the rest of the 60s TTL. (writeFile already invalidates the
    // underlying readFile cache; this clears the parsed layer above it.)
    invalidateUserConfigCache();

    revalidatePath("/");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Reset to factory defaults. */
export async function resetUserConfig(): Promise<{ ok: boolean }> {
  return saveUserConfig(DEFAULTS);
}
