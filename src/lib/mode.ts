/**
 * Deployment mode — single source of truth for cloud vs. client.
 *
 * Controlled by the PREVIOUSLY_MODE environment variable:
 *
 *   PREVIOUSLY_MODE=client  → local client instance (local datasource by
 *                             default, local workflow world)
 *   unset / anything else   → "cloud" (the default)
 *
 * The whole codebase reads the mode only from here — no other module reads
 * process.env.PREVIOUSLY_MODE. The mode only affects "where am I, who do I
 * talk to" (datasource default, workflow world); it never changes identity,
 * directives, or episodic semantics (see doc/design/v0.9-client.md §2).
 */

export type PreviouslyMode = "cloud" | "client";

/**
 * The effective deployment mode. Only the exact value "client" opts into
 * client mode; everything else (including unset) is cloud.
 */
export function getMode(): PreviouslyMode {
  return process.env.PREVIOUSLY_MODE === "client" ? "client" : "cloud";
}

/** Shortcut: are we running as a local client instance? */
export function isClientMode(): boolean {
  return getMode() === "client";
}
