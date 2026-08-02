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
import { mergeConfig, DEFAULTS } from "./defaults";
import { loadUserConfig } from "./loader";
import type { UserConfig, ModelConfig, WorkerConfig } from "./types";

const CONFIG_PATH = "memory/user/config.json";

/** Partial overrides — the nested model/worker objects are partial too. */
export type UserConfigOverrides = Partial<
  Omit<UserConfig, "model" | "worker">
> & {
  model?: Partial<ModelConfig>;
  worker?: Partial<WorkerConfig>;
};

/** Client-safe view of the current config (model ids, limits — no secrets). */
export async function getUserConfig(): Promise<UserConfig> {
  return loadUserConfig();
}

/**
 * Deep-merge partial overrides onto the current config. Unlike `mergeConfig`
 * (which merges onto factory defaults), this preserves the CURRENT nested
 * groups and also carries top-level fields (onboarded, datasource) — so a
 * save never clobbers what's already stored.
 */
export function mergeConfigOverrides(
  current: UserConfig,
  overrides: UserConfigOverrides,
): UserConfig {
  return mergeConfig({
    ...overrides,
    slicing: { ...current.slicing, ...overrides.slicing },
    context: { ...current.context, ...overrides.context },
    model: { ...current.model, ...overrides.model },
    worker: { ...current.worker, ...overrides.worker },
  });
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
