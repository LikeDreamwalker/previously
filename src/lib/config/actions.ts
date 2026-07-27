"use server";

/**
 * Server action: persist user config to `memory/user/config.json`.
 * Accepts a partial config — only the fields the user touched in Settings.
 * Re-validates the home page so the agent picks up new values on next request.
 */
import { revalidatePath } from "next/cache";
import { writeFile } from "@/lib/tools/writeFile";
import { writeFileLocal } from "@/lib/tools/local-fs";
import { canWrite, getRepoConfig, isDemo } from "@/lib/capabilities";
import { mergeConfig, DEFAULTS } from "./defaults";
import { loadUserConfig } from "./loader";
import type { UserConfig } from "./types";

const CONFIG_PATH = "memory/user/config.json";

export async function saveUserConfig(
  overrides: Partial<UserConfig>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Demo mode: config writes are not persisted.
    if (isDemo()) {
      return { ok: false, error: "Config changes are not saved in demo mode. Deploy your own instance to customize settings." };
    }

    const current = await loadUserConfig();
    const merged = mergeConfig({
      slicing: { ...current.slicing, ...overrides.slicing },
      context: { ...current.context, ...overrides.context },
      model: { ...current.model, ...overrides.model },
    });

    const json = JSON.stringify(merged, null, 2);

    if (canWrite()) {
      const { owner, repo } = getRepoConfig();
      await writeFile(CONFIG_PATH, json, repo, owner);
    } else {
      await writeFileLocal(CONFIG_PATH, json);
    }

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
