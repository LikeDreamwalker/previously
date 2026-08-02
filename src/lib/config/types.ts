/**
 * User-facing configuration schema. Stored as `memory/user/config.json` in the
 * user's GitHub memory repo — editable via Settings UI, read at request time.
 * Every field is optional; missing values fall back to defaults.
 */

export interface SlicingConfig {
  /** Force-close the active slice after this many turns (safety net). */
  maxTurnsPerSlice: number;
  /** Minutes of inactivity before a time-silence split triggers. */
  timeSilenceMinutes: number;
}

export interface ContextConfig {
  /** How many recent conversation turns to include in the assembled prompt. */
  recentTurnsLimit: number;
}

export interface ModelConfig {
  /** Provider model id (e.g. "deepseek-v4-flash", "deepseek-v4-pro"). */
  provider: string;
  /** Whether reasoning/thinking is enabled for the Pro tier. */
  thinking: boolean;
  /** Thinking depth: "low" | "medium" | "high". Controls reasoning token spend. */
  reasoningEffort: "low" | "medium" | "high";
}

/**
 * The auxiliary "worker" model — used for cheap internal calls (tag extraction,
 * slice marking, recall search, belief evolution, loop workers). Distinct from
 * the main chat model so the user can keep a fast/cheap tier behind the scenes.
 */
export interface WorkerConfig {
  /** "auto" = derive from the main model (same-provider lightweight → main);
   *  "manual" = use `provider` verbatim. */
  mode: "auto" | "manual";
  /** Pinned worker model id, used when mode = "manual". */
  provider: string;
}

export interface UserConfig {
  slicing: SlicingConfig;
  context: ContextConfig;
  model: ModelConfig;
  worker: WorkerConfig;
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
  Omit<UserConfig, "model" | "worker">
> & {
  model?: Partial<ModelConfig>;
  worker?: Partial<WorkerConfig>;
};
