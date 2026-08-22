/**
 * Shared prompt base for the sub-agents (v0.9 unified sub-agent architecture).
 *
 * Every sub-agent's system prompt is `buildSubAgentSystem(role)` — the static
 * SHARED_SUBAGENT_BASE plus a static role block. Fully static system prompts
 * mean every sub-agent call shares one prefix, so provider prefix caches hit
 * across calls. ALL per-call content (task data, current time, signals)
 * belongs in the USER prompt, never in system.
 */

/**
 * The static base every sub-agent shares: where it works, how slice ids and
 * time behave, tool discipline, output conventions. Keep this SHORT — it is
 * prepended to every sub-agent call.
 */
export const SHARED_SUBAGENT_BASE = `You are a sub-agent of the Previously memory system — a personal AI that organizes conversations into time slices.

Time and slices:
- A slice id like 2026-08-11-0930 encodes the slice's START as a user-local wall clock (YYYY-MM-DD-HHMM, 24h). A slice covers a bounded window of conversation.
- Treat timestamps and dates in the task material as authoritative; never infer dates from your own knowledge.

Discipline:
- You run once, with a bounded step budget and a hard deadline. Do exactly the task in the user message — no exploration beyond the tools you are given, and never repeat a call that was already rejected.
- Report through the designated report tool, following its input schema exactly. Keep every field short — this is metadata, not prose.
- Write your analysis in English; quote user-facing material verbatim in its original language.`;

/** System prompt for a sub-agent: the shared static base + a static role block. */
export function buildSubAgentSystem(roleInstructions: string): string {
  return `${SHARED_SUBAGENT_BASE}\n\n${roleInstructions}`;
}
