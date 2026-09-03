/**
 * Typed I/O over the evolution data files (v1.0 design §2.2–§2.6) — the STORE
 * half. The analyzer scores (turn-analyzer.ts), the trigger math aggregates
 * (triggers.ts), and the evolution agent mutates (previously-agent.ts /
 * direction-agent.ts); this module only guarantees the
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
  playbookPath,
  type PlaybookAgent,
} from "./paths";

// ─── Direction document (design §2.2) ────────────────────────────────────

/** The minimal direction.md template — the two fixed sections of the USER
 *  PORTRAIT (six fixed dimensions) + HYPOTHESIS POOL (see direction-agent.ts).
 *  Only the skeleton and the writing discipline are fixed; the content is the
 *  evolution agent's. */
const DIRECTION_TEMPLATE = `# Portrait

_(Not set yet — confirmed, cross-slice understanding of WHO the user is: descriptive, portrait-grade (holds across contexts, outlives its evidence, predicts), never imperatives. Slice pointers ride trailing "— refs:" tails only.)_

## Traits & cognitive style

## Triggers & rhythms

## Patterns & loops

## Strengths & resilience

## Communication preferences

## Values & boundaries

# Hypotheses

_(Not set yet — bounded dynamic pool of trait-level guesses (≤10), each "- [proposed YYYY-MM-DD-HHMM] <guess> — falsify if: <condition>". Confirmed → promoted into the Portrait in the same run; refuted → removed; unverified 4 slices → retired. Refilled toward 10 each run.)_
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
  /**
   * Slice ids whose direction proposal was already REJECTED once (v1.1
   * per-slice backoff): the doc keeps its old skeleton after a rejection, so
   * the migrate/bootstrap gate would otherwise re-fire the full merged
   * evolution run on EVERY remaining turn of that slice. Housekeeping reads
   * this list and stops gating on the direction for the rest of the slice;
   * the NEXT slice retries fresh (a new slice, a new chance). Ids are never
   * reused, so the bound below only ages out long-dead slices.
   */
  directionRejections: string[];
}

/** Retention bounds — the store is read whole, so it must not grow forever. */
export const MAX_FITNESS_EVENTS = 200;
export const MAX_FITNESS_SIGNALS = 200;
/** Rejection ids are one-per-slice at most; only the CURRENT slice's
 *  membership is ever consulted, so a shallow tail is plenty. */
export const MAX_DIRECTION_REJECTIONS = 50;

export function emptyFitnessStore(): FitnessStore {
  return { events: [], signals: [], directionRejections: [] };
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
      directionRejections: Array.isArray(parsed.directionRejections)
        ? parsed.directionRejections
        : [],
    };
  } catch {
    return emptyFitnessStore();
  }
}

async function writeFitness(
  store: FitnessStore,
  batch?: WriteBatch,
): Promise<void> {
  // Keep the newest entries — the tail is what the generation aggregation
  // (bucketNetScore) and the analyzer actually read. (Generations keep the
  // store small by design; the caps are a pure safety valve.)
  const bounded: FitnessStore = {
    events: store.events.slice(-MAX_FITNESS_EVENTS),
    signals: store.signals.slice(-MAX_FITNESS_SIGNALS),
    directionRejections: store.directionRejections.slice(
      -MAX_DIRECTION_REJECTIONS,
    ),
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

/**
 * Settle the current generation (v0.9.2): a SUCCESSFUL evolution run has
 * responded to everything the store was holding — the outcome already
 * sedimented into the card / direction / playbooks, so the scored events
 * and mechanical signals that produced it are spent and cleared. Every
 * bucket re-accumulates from zero; there is deliberately no cross-generation
 * bookkeeping (evolution has no direction — nothing is judged against its
 * predecessor and nothing rolls back). directionRejections survive: they are
 * a per-slice UI backoff, not selection pressure. Never demo-reachable —
 * housekeeping's evolution block is skipped entirely in demo mode.
 */
export async function resetFitnessGeneration(batch?: WriteBatch): Promise<void> {
  const store = await readFitness(batch);
  if (store.events.length === 0 && store.signals.length === 0) return;
  await writeFitness(
    { events: [], signals: [], directionRejections: store.directionRejections },
    batch,
  );
}

/**
 * Record that this slice's direction proposal was REJECTED by validation —
 * the per-slice backoff for the migrate/bootstrap gate (see the
 * directionRejections field). Idempotent per slice. Never demo-reachable:
 * housekeeping's evolution block is skipped entirely in demo mode.
 */
export async function recordDirectionRejection(
  sliceId: string,
  batch?: WriteBatch,
): Promise<void> {
  const store = await readFitness(batch);
  if (store.directionRejections.includes(sliceId)) return;
  store.directionRejections.push(sliceId);
  await writeFitness(store, batch);
}

/** The newest `n` signals, oldest-first (chronological read order). */
export async function readRecentSignals(n: number): Promise<FitnessSignal[]> {
  const store = await readFitness();
  return store.signals.slice(-Math.max(0, n));
}

/**
 * Net score for one bucket over the CURRENT GENERATION (design §2.5: the
 * aggregation lives in CODE, deterministic; the LLM only ever produces
 * single evidence-anchored deltas). Every event in the store is
 * current-generation by construction — a successful evolution run settles
 * the store (resetFitnessGeneration), so there is no window to compute.
 * Pure — takes the store, never reads it.
 */
export function bucketNetScore(
  store: FitnessStore,
  bucket: FitnessBucket,
): number {
  let net = 0;
  for (const e of store.events) {
    if (e.bucket === bucket) net += e.delta;
  }
  return net;
}
