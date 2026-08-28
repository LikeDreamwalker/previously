/**
 * Typed I/O over the evolution data files (v1.0 design §2.2–§2.7) — the STORE
 * half. The analyzer scores (turn-analyzer.ts), the evolution agent mutates
 * (previously-agent.ts / direction-agent.ts), and the acceptance-rule
 * orchestration lives in ./acceptance.ts; this module only guarantees the
 * data layer is safe to build on:
 *
 *   - All reads/writes route through io-helpers (fsReadFile / fsWriteFile), so
 *     demo / GitHub / local resolution — and explicit WriteBatch threading —
 *     behave exactly like the rest of the memory subsystem.
 *   - Missing files degrade to null / empty stores, never to errors: a fresh
 *     deployment has no evolution data yet, and that is a normal state.
 *   - Evidence-anchoring is STRUCTURAL, not prompt-level: a fitness event with
 *     blank evidence is force-stored with delta 0 (design §2.5 — "无证据强制归
 *     0"). No caller, however buggy or hallucinating, can score without evidence.
 *   - The stores are BOUNDED (newest ~200 events / ~200 signals): the files are
 *     read whole on every use, so unbounded growth would eventually flood every
 *     evolution prompt that quotes them.
 */

import {
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import {
  DIRECTION_PATH,
  FITNESS_PATH,
  MUTATIONS_PATH,
  playbookPath,
  type PlaybookAgent,
} from "./paths";

// ─── Direction document (design §2.2) ────────────────────────────────────

/** The minimal direction.md template — the four fixed sections from design
 *  §2.2. The taxonomy is deliberately open (the agent may grow new
 *  dimensions); only the writing discipline is fixed. */
const DIRECTION_TEMPLATE = `# Direction

_(Not set yet — what "better for the user" means across slices gets written here.)_

# Anti-goals

_(Not set yet — the drift guardrails: what we must NOT evolve into.)_

# Evidence

_(Each direction conclusion links its supporting slice pointers here.)_

# Log

_(Append-only: when the direction changed, and on what evidence.)_
`;

/**
 * Read the evolution-direction document. Returns null when it does not exist
 * yet (a fresh deployment is a normal state, not an error).
 */
export async function readDirection(): Promise<string | null> {
  try {
    const content = await fsReadFile(DIRECTION_PATH);
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/**
 * True when the direction doc has never actually been written — missing file,
 * or still the untouched bootstrap template (the "(Not set yet" placeholders
 * are the tell; writeDirection replaces the whole doc, so any real write
 * clears them). Used to gate the bootstrap path: the FIRST direction gets a
 * lowered evidence bar (see direction-agent.ts).
 */
export function isDirectionTemplate(content: string | null): boolean {
  if (content === null) return true;
  return content.includes("(Not set yet");
}

/** Overwrite the direction document. The EVOLUTION AGENT is the only writer
 *  (design §3 — single-writer discipline); this helper does not judge content. */
export async function writeDirection(
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(DIRECTION_PATH, content, batch);
}

/**
 * Read the append-only mutation archive (design §2.7). Returns null when it
 * does not exist yet (no accepted mutations is a normal state, not an error).
 */
export async function readMutations(): Promise<string | null> {
  try {
    const content = await fsReadFile(MUTATIONS_PATH);
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort bootstrap: create direction.md from the minimal template when
 * (and only when) it is missing. Never throws, never overwrites existing
 * content — the whole point of the file is that an evolved direction survives.
 */
export async function ensureEvolutionFiles(): Promise<void> {
  try {
    await fsReadFile(DIRECTION_PATH);
    return; // exists — leave it untouched
  } catch {
    // Missing (or unreadable) — try to create below.
  }
  try {
    await fsWriteFile(DIRECTION_PATH, DIRECTION_TEMPLATE);
  } catch (e) {
    console.warn(
      "[Evolution] could not bootstrap direction.md:",
      e instanceof Error ? e.message : e,
    );
  }
}

// ─── Playbooks (design §2.4) ─────────────────────────────────────────────

/**
 * Hard cap on INJECTED playbook length. A playbook is short working notes by
 * design; a bloated one would flood every sub-agent prompt, so injection
 * truncates with a marker rather than failing.
 */
export const MAX_PLAYBOOK_CHARS = 2000;

/** Truncate a playbook to the injection budget, marking the cut so the
 *  sub-agent knows the notes continue beyond what it sees. */
export function capPlaybook(content: string): string {
  if (content.length <= MAX_PLAYBOOK_CHARS) return content;
  return (
    content.slice(0, MAX_PLAYBOOK_CHARS) +
    `\n\n[…playbook truncated at ${MAX_PLAYBOOK_CHARS} chars]`
  );
}

/**
 * Read a sub-agent's evolved playbook. Returns null when missing/blank — the
 * caller then omits the injection block entirely (no behavior change).
 */
export async function readPlaybook(
  agent: PlaybookAgent,
): Promise<string | null> {
  try {
    const content = await fsReadFile(playbookPath(agent));
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** Overwrite a sub-agent's playbook. Evolution-agent writes only (design §3). */
export async function writePlaybook(
  agent: PlaybookAgent,
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(playbookPath(agent), content, batch);
}

// ─── Fitness store (design §2.5 / §2.6) ──────────────────────────────────

/** The attribution buckets — each scores (or observes) independently. */
export type FitnessBucket =
  | "card"
  | "recall"
  | "search"
  | "thinkdeep"
  | "interaction";

/**
 * One scored observation. Coarse ordinal only: -2 explicit complaint/correction,
 * -1 dissatisfaction signs, 0 no signal, +1 explicit approval. A non-zero delta
 * is only meaningful WITH user-verbatim evidence — enforced structurally in
 * appendFitnessEvents.
 */
export interface FitnessEvent {
  ts: string;
  sliceId: string;
  bucket: FitnessBucket;
  delta: -2 | -1 | 0 | 1;
  /** User's own words (or a slice pointer) backing a non-zero delta. */
  evidence: string;
}

/**
 * A mechanical observation, NOT a score: emitted by instrumentation (the
 * rework signal of design §2.6) rather than by any model. The analyzer stage
 * reads these when scoring; nothing here interprets them.
 */
export interface FitnessSignal {
  ts: string;
  sliceId: string;
  type: "recall_verify" | "recall_rework" | "recall_repeat" | "interaction_regenerate" | "interaction_interrupt";
  detail: string;
}

export interface FitnessStore {
  events: FitnessEvent[];
  signals: FitnessSignal[];
}

/** Retention bounds — the store is read whole, so it must not grow forever. */
export const MAX_FITNESS_EVENTS = 200;
export const MAX_FITNESS_SIGNALS = 200;

export function emptyFitnessStore(): FitnessStore {
  return { events: [], signals: [] };
}

/**
 * Read the fitness store. Missing or CORRUPT files both degrade to the empty
 * store — the store is an append log of soft signals, and losing it must never
 * break a turn.
 */
export async function readFitness(batch?: WriteBatch): Promise<FitnessStore> {
  try {
    const raw = await fsReadFile(FITNESS_PATH, batch);
    const parsed = JSON.parse(raw) as Partial<FitnessStore>;
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    };
  } catch {
    return emptyFitnessStore();
  }
}

async function writeFitness(
  store: FitnessStore,
  batch?: WriteBatch,
): Promise<void> {
  // Keep the newest entries — the tail is what the sliding-window aggregation
  // (bucketNetScore) and the analyzer actually read.
  const bounded: FitnessStore = {
    events: store.events.slice(-MAX_FITNESS_EVENTS),
    signals: store.signals.slice(-MAX_FITNESS_SIGNALS),
  };
  await fsWriteFile(FITNESS_PATH, JSON.stringify(bounded, null, 2), batch);
}

/**
 * Append scored events. STRUCTURAL evidence-anchoring: an event whose
 * evidence is empty/whitespace is stored with delta 0 no matter what the
 * caller passed — scoring without evidence is impossible by construction
 * here, not by prompt discipline.
 */
export async function appendFitnessEvents(
  events: FitnessEvent[],
  batch?: WriteBatch,
): Promise<void> {
  if (events.length === 0) return;
  const store = await readFitness(batch);
  const normalized = events.map((e) =>
    e.evidence.trim() ? e : { ...e, delta: 0 as const },
  );
  store.events.push(...normalized);
  await writeFitness(store, batch);
}

/** Append one mechanical signal (see FitnessSignal). */
export async function appendSignal(
  signal: FitnessSignal,
  batch?: WriteBatch,
): Promise<void> {
  const store = await readFitness(batch);
  store.signals.push(signal);
  await writeFitness(store, batch);
}

/** The newest `n` signals, oldest-first (chronological read order). */
export async function readRecentSignals(n: number): Promise<FitnessSignal[]> {
  const store = await readFitness();
  return store.signals.slice(-Math.max(0, n));
}

/**
 * Net score for one bucket over the newest `windowSlices` DISTINCT slices
 * (design §2.5: the sliding-window aggregation lives in CODE, deterministic;
 * the LLM only ever produces single evidence-anchored deltas). Pure — takes
 * the store, never reads it.
 */
export function bucketNetScore(
  store: FitnessStore,
  bucket: FitnessBucket,
  windowSlices = 10,
): number {
  // The window is defined over ALL events (recency is a property of the
  // slices, not of one bucket), then the sum is bucket-filtered.
  const window = new Set<string>();
  for (let i = store.events.length - 1; i >= 0 && window.size < windowSlices; i--) {
    window.add(store.events[i].sliceId);
  }
  let net = 0;
  for (const e of store.events) {
    if (e.bucket === bucket && window.has(e.sliceId)) net += e.delta;
  }
  return net;
}

/**
 * Net score for one bucket over the events STRICTLY NEWER than `sinceTs`
 * (design §2.7 — the effectiveness window: did the bucket keep losing points
 * after a mutation landed?). ISO timestamps compare lexicographically. Pure —
 * takes the store, never reads it.
 */
export function bucketNetScoreSince(
  store: FitnessStore,
  bucket: FitnessBucket,
  sinceTs: string,
): number {
  let net = 0;
  for (const e of store.events) {
    if (e.bucket === bucket && e.ts > sinceTs) net += e.delta;
  }
  return net;
}

// ─── Mutations archive (design §2.7) ─────────────────────────────────────

/** What an accepted mutation touched. */
export type MutationTarget =
  | "direction"
  | "card"
  | "playbook:recall"
  | "playbook:search"
  | "playbook:thinkdeep";

/**
 * One accepted mutation, archived append-only. Every mutation must carry its
 * expected benefit and evidence pointers (design §2.7); there is no automatic
 * rollback, cooldown, or mutation budget — an ineffective mutation is marked
 * in the log later, never deleted.
 */
export interface MutationRecord {
  ts: string;
  target: MutationTarget;
  summary: string;
  evidence: string[];
  expectedBenefit: string;
}

const MUTATIONS_HEADER = `# Mutations Archive

Append-only log of accepted evolution mutations (design v1.0 §2.7). No
automatic rollback, no cooldown, no mutation budget — a mutation that proves
ineffective is marked \`ineffective\` here later, never deleted.
`;

/** Render one record as a compact, greppable markdown block. */
export function renderMutationRecord(record: MutationRecord): string {
  const evidence = record.evidence.length
    ? record.evidence.map((e) => `  - ${e}`).join("\n")
    : "  - (none recorded)";
  return [
    `## ${record.ts} — ${record.target}`,
    "",
    `- **Summary:** ${record.summary}`,
    `- **Expected benefit:** ${record.expectedBenefit}`,
    `- **Evidence:**`,
    evidence,
  ].join("\n");
}

/** Append a mutation to the archive, creating the file (with its header) when
 *  missing. Append-only: existing content is never rewritten. */
export async function appendMutation(
  record: MutationRecord,
  batch?: WriteBatch,
): Promise<void> {
  let existing = "";
  try {
    existing = await fsReadFile(MUTATIONS_PATH, batch);
  } catch {
    // Archive missing — created below with its header.
  }
  const block = renderMutationRecord(record);
  const content = existing.trim()
    ? `${existing.trimEnd()}\n\n${block}\n`
    : `${MUTATIONS_HEADER}\n${block}\n`;
  await fsWriteFile(MUTATIONS_PATH, content, batch);
}
