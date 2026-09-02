/**
 * Path constants for the evolution data layer (v1.0 design §2).
 *
 * Everything here is memory DATA under `memory/` — the mutable surface the
 * evolution loop owns. The sub-agent contracts (schemas, tools, step budgets)
 * stay in `src/`; these files are what the evolution agent may rewrite
 * (direction doc, per-agent playbooks) or append to (fitness store). Keeping
 * the paths in one module keeps every reader/writer byte-identical on where
 * the truth lives.
 */

/** The cross-slice user-portrait document (design §2.2). */
export const DIRECTION_PATH = "memory/evolution/direction.md";

/** Fitness events + mechanical signals store (design §2.5 / §2.6). */
export const FITNESS_PATH = "memory/evolution/fitness.json";

/** Directory holding the per-sub-agent evolved playbooks (design §2.4). */
export const PLAYBOOK_DIR = "memory/agent-playbooks";

/** The sub-agents that carry an evolvable playbook. */
export type PlaybookAgent = "recall" | "search" | "thinkdeep";

export function playbookPath(agent: PlaybookAgent): string {
  return `${PLAYBOOK_DIR}/${agent}.md`;
}
