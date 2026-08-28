import type { UserConfig, UserConfigOverrides } from "./types";
import { resolveModelId } from "@/lib/models/registry";

/**
 * Hard defaults. When `memory/user/config.json` is missing or a field is
 * absent, these values apply. Keep them conservative — they ship to every
 * user who hasn't customized their config.
 */
export const DEFAULTS: UserConfig = {
  slicing: {
    maxSliceMinutes: 30,
    maxTurnsPerSlice: 50,
  },
  model: {
    provider: "deepseek-v4-pro",
    thinking: true,
    reasoningEffort: "medium" as const,
  },
  onboarded: false,
  datasource: "demo",
};

/**
 * Shallow-merge partial user overrides onto defaults. Only the keys present in
 * `overrides` are applied; missing keys stay at their default values. A stored
 * legacy model id (pre-V4) is normalized to its successor.
 */
export function mergeConfig(overrides: Partial<UserConfig>): UserConfig {
  const model = { ...DEFAULTS.model, ...overrides.model };
  model.provider = resolveModelId(model.provider);
  return {
    slicing: { ...DEFAULTS.slicing, ...overrides.slicing },
    model,
    onboarded: overrides.onboarded ?? DEFAULTS.onboarded,
    datasource: overrides.datasource ?? DEFAULTS.datasource,
  };
}

/**
 * Deep-merge partial overrides onto an existing config. Unlike `mergeConfig`
 * (which merges onto factory defaults), this preserves the CURRENT nested
 * groups and carries top-level fields (onboarded, datasource) — so a save
 * never clobbers what's already stored.
 */
export function mergeConfigOverrides(
  current: UserConfig,
  overrides: UserConfigOverrides,
): UserConfig {
  return mergeConfig({
    ...overrides,
    slicing: { ...current.slicing, ...overrides.slicing },
    model: { ...current.model, ...overrides.model },
  });
}
