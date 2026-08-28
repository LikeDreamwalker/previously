/**
 * User-facing configuration schema. Stored as `memory/user/config.json` in the
 * user's GitHub memory repo — editable via Settings UI, read at request time.
 * Every field is optional; missing values fall back to defaults.
 */

export interface SlicingConfig {
  /** Force-close the active slice this many minutes after it starts. */
  maxSliceMinutes: number;
  /** Force-close the active slice after this many turns (safety net). */
  maxTurnsPerSlice: number;
}

export interface ModelConfig {
  /** Provider model id (e.g. "deepseek-v4-flash", "deepseek-v4-pro"). */
  provider: string;
  /** Whether reasoning/thinking is enabled for the Pro tier. */
  thinking: boolean;
  /** Thinking depth: "low" | "medium" | "high". Controls reasoning token spend. */
  reasoningEffort: "low" | "medium" | "high";
}

export interface UserConfig {
  slicing: SlicingConfig;
  model: ModelConfig;
  /** Has the user completed the onboarding welcome flow? */
  onboarded?: boolean;
  /** User's preferred data source: "demo" (benchmark personas) or "own" (GitHub repo). Only persisted when writes are available. */
  datasource?: "demo" | "own";
}

/**
 * Partial config overrides for a save — nested groups are partial too, so
 * callers can touch just `model.provider` without respecifying the rest.
 */
export type UserConfigOverrides = Partial<
  Omit<UserConfig, "model">
> & {
  model?: Partial<ModelConfig>;
};
