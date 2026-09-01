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
    idleGapMinutes: 15,
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
 * Server-side clamps for the three slicing knobs (v0.9.1). The Settings inputs
 * are plain `<input type="number">` — min/max are HTML hints only: an emptied
 * field arrives as 0, a hand-typed negative sails through, and NaN crosses the
 * JSON round-trip as null. Unclamped, `idleGapMinutes: 0` makes checkIdleGap's
 * `>=` always true (`null * 60_000 === 0` even slips past its NaN guard), so
 * EVERY turn closes idle_gap with no carry-over and the model only ever sees
 * the current message; `maxSliceMinutes: 0` / `maxTurnsPerSlice: 0` force-close
 * every turn the same way. Non-finite/non-numeric values fall back to the
 * DEFAULT (not the nearest bound — a garbage value signals "broken input", not
 * "user wants the extreme"); finite values are integerized and clamped.
 */
const SLICING_LIMITS = {
  maxSliceMinutes: { min: 5, max: 240 },
  maxTurnsPerSlice: { min: 5, max: 100 },
  idleGapMinutes: { min: 1, max: 120 },
} as const;

function sanitizeSlicing(
  overrides: Partial<UserConfig>["slicing"] | undefined,
): UserConfig["slicing"] {
  const out = { ...DEFAULTS.slicing };
  for (const key of Object.keys(SLICING_LIMITS) as Array<keyof typeof SLICING_LIMITS>) {
    const v = overrides?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue; // keep default
    const { min, max } = SLICING_LIMITS[key];
    out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  return out;
}

/**
 * Shallow-merge partial user overrides onto defaults. Only the keys present in
 * `overrides` are applied; missing keys stay at their default values. A stored
 * legacy model id (pre-V4) is normalized to its successor. The slicing knobs
 * are sanitized (see SLICING_LIMITS) — mergeConfig is the single funnel for
 * every read (loadUserConfig) and every save (mergeConfigOverrides), so the
 * clamp covers both a corrupted stored file and a hostile/buggy client.
 */
export function mergeConfig(overrides: Partial<UserConfig>): UserConfig {
  const model = { ...DEFAULTS.model, ...overrides.model };
  model.provider = resolveModelId(model.provider);
  return {
    slicing: sanitizeSlicing(overrides.slicing),
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
