import type { UserConfig } from "./types";
import { resolveModelId } from "@/lib/models/registry";

/**
 * Hard defaults. When `memory/user/config.json` is missing or a field is
 * absent, these values apply. Keep them conservative — they ship to every
 * user who hasn't customized their config.
 */
export const DEFAULTS: UserConfig = {
  slicing: {
    maxTurnsPerSlice: 20,
    timeSilenceMinutes: 15,
  },
  context: {
    recentTurnsLimit: 20,
  },
  model: {
    provider: "deepseek-v4-pro",
    thinking: true,
    reasoningEffort: "medium" as const,
  },
  worker: {
    mode: "auto" as const,
    provider: "",
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
  const worker = {
    ...DEFAULTS.worker,
    ...(overrides.worker ?? {}),
  };
  if (worker.provider) worker.provider = resolveModelId(worker.provider);
  return {
    slicing: { ...DEFAULTS.slicing, ...overrides.slicing },
    context: { ...DEFAULTS.context, ...overrides.context },
    model,
    worker,
    onboarded: overrides.onboarded ?? DEFAULTS.onboarded,
    datasource: overrides.datasource ?? DEFAULTS.datasource,
  };
}
