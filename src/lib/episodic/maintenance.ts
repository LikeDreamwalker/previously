/**
 * Episodic memory maintenance — deprecated v1 module, kept as a stub.
 *
 * Flash LLM calls live in dedicated modules:
 *   - src/lib/episodic/flash/recall.ts           (recall search mini-agent)
 *   - src/lib/episodic/flash/previously-agent.ts  (previously.md evolution)
 *   - src/lib/episodic/previously-updater.ts      (v2 belief mutations)
 *
 * This module is retained for backward-compatible barrel exports
 * from index.ts only. No active code lives here.
 *
 * Tag extraction now happens in the housekeeping step
 * (src/app/api/chat/steps.ts) via extractFlashTags().
 */
