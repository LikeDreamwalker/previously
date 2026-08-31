/**
 * User-facing configuration schema. Stored as `memory/user/config.json` in the
 * user's GitHub memory repo — editable via Settings UI, read at request time.
 * Every field is optional; missing values fall back to defaults.
 */

export interface SlicingConfig {
  /** Force-close the active slice this many minutes after it starts (a
   *  periodic autosave checkpoint — the follow-up slice continues the same
   *  conversation via `continuesFrom`). */
  maxSliceMinutes: number;
  /** Force-close the active slice after this many turns (safety net — also a
   *  checkpoint close, continued via `continuesFrom`). */
  maxTurnsPerSlice: number;
  /** Close the active slice when this many minutes have passed since its last
   *  turn — a long silence means the user left and came back, so the next
   *  message opens a genuinely new conversation (`"idle_gap"`, no carry-over). */
  idleGapMinutes: number;
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
