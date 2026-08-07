/**
 * Strand index pure functions — normalization, merge, and pruning.
 *
 * The strand index (`strands.json`) maps a keyword to the slice paths that
 * carry it. Historically it grew append-only: every tag the worker model
 * emitted became a key, with no normalization (so `apex` and `Apex` coexisted),
 * no merge (so `陈勇超` and `陈永超` split one concept), and no pruning (so a
 * tag seen once ever stayed forever). This module is the deterministic
 * counterweight to that: cheap, pure, and testable.
 *
 * Pure functions only — no I/O, no LLM calls, no Node dependencies.
 */
import type { StrandIndex } from "./types";

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalize a strand key for comparison and storage:
 * - trim surrounding whitespace,
 * - lowercase ASCII (so `Apex` / `apex` unify),
 * - map full-width forms to half-width (so `Ａpex` / `Apex` unify),
 * - collapse inner whitespace runs to a single space.
 *
 * Chinese/semantic duplicates (`陈勇超` vs `陈永超`) are NOT caught here —
 * that is the LLM consolidation pass's job. This only removes mechanical
 * variation.
 */
export function normalizeStrandKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/\s+/g, " ");
}

/**
 * Find an existing strand key that normalizes to the same form as `tag`.
 * Returns the existing key (preserving its original casing) or null.
 */
export function findMatchingStrand(
  strands: StrandIndex,
  tag: string,
): string | null {
  const norm = normalizeStrandKey(tag);
  if (!norm) return null;
  for (const existing of Object.keys(strands)) {
    if (normalizeStrandKey(existing) === norm) return existing;
  }
  return null;
}

/**
 * Weave a single tag into the strand index under the merge-first rule:
 * if a normalized-matching strand already exists, the slice path is attached
 * under THAT key (never creating a near-duplicate); only a genuinely new tag
 * creates a new key (stored normalized). Slice paths are deduplicated.
 *
 * Returns the key the tag landed under and whether a new key was created.
 */
export function weaveTag(
  strands: StrandIndex,
  tag: string,
  slicePath: string,
): { key: string; created: boolean } {
  const existing = findMatchingStrand(strands, tag);
  const key = existing ?? normalizeStrandKey(tag);
  if (!strands[key]) {
    strands[key] = [];
  }
  const created = !existing;
  if (!strands[key].includes(slicePath)) {
    strands[key].push(slicePath);
  }
  return { key, created };
}

/**
 * Merge existing strands by a from→to map (produced by the LLM consolidation
 * pass or by hand). Path lists are unioned (deduped), `from` keys removed.
 * The `to` key is normalized before lookup/creation, so a merge onto a
 * casing-variant key still lands on the canonical one.
 */
export function applyStrandMerges(
  strands: StrandIndex,
  merges: Array<{ from: string; to: string }>,
): { applied: number } {
  let applied = 0;
  for (const { from, to } of merges) {
    if (from === to) continue;

    // Resolve the target first: exact existing key, else normalized target.
    const target = findMatchingStrand(strands, to) ?? normalizeStrandKey(to);
    if (!target) continue;

    // Resolve the `from` key. Prefer an exact key match; else a normalized
    // match, but NEVER the target itself (when `from` and `to` are casing
    // variants of the same word, the from-key must be the OTHER key).
    let fromKey: string | null = null;
    if (strands[from] !== undefined) {
      fromKey = from;
    } else {
      const fromNorm = normalizeStrandKey(from);
      for (const existing of Object.keys(strands)) {
        if (existing === target) continue;
        if (normalizeStrandKey(existing) === fromNorm) {
          fromKey = existing;
          break;
        }
      }
    }
    if (!fromKey || fromKey === target) continue;

    const paths = strands[fromKey];
    if (!strands[target]) strands[target] = [];
    for (const p of paths) {
      if (!strands[target].includes(p)) strands[target].push(p);
    }
    delete strands[fromKey];
    applied += 1;
  }
  return { applied };
}

// ─── Pruning ────────────────────────────────────────────────────────────────

/**
 * Parse a slice path ("2026/08/07/0733") into a UTC millisecond timestamp.
 * Returns null for malformed paths.
 */
export function slicePathToMs(path: string): number | null {
  const m = path.match(/^(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, y, mo, d, hhmm] = m;
  const hour = Number(hhmm.slice(0, 2));
  const min = Number(hhmm.slice(2, 4));
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, min);
  return Number.isNaN(ts) ? null : ts;
}

export interface PruneOptions {
  /** A strand with fewer than `minSlices` slices is a pruning candidate. */
  minSlices?: number;
  /**
   * A candidate is pruned only if every one of its slices is older than
   * `maxSliceAgeMs` (i.e. the strand hasn't been re-confirmed recently).
   * Default: 14 days.
   */
  maxSliceAgeMs?: number;
  /** Now in ms — injectable for tests. */
  nowMs?: number;
}

/**
 * Prune strands that never became threads: few slices AND all of them stale.
 *
 * The intent is to remove "today's one-off tag" without killing a genuinely
 * new strand the day it appears — a strand survives if it has enough slices
 * (minSlices, default 2) OR has at least one recent slice.
 */
export function pruneStrands(
  strands: StrandIndex,
  opts: PruneOptions = {},
): { strands: StrandIndex; pruned: string[] } {
  const minSlices = opts.minSlices ?? 2;
  const maxSliceAgeMs = opts.maxSliceAgeMs ?? 14 * 24 * 60 * 60 * 1000;
  const nowMs = opts.nowMs ?? Date.now();

  const pruned: string[] = [];
  const kept: StrandIndex = {};

  for (const [key, paths] of Object.entries(strands)) {
    if (paths.length >= minSlices) {
      kept[key] = paths;
      continue;
    }
    // Few slices: keep if any slice is recent enough to count as "re-confirmed".
    const anyRecent = paths.some((p) => {
      const ts = slicePathToMs(p);
      return ts !== null && nowMs - ts <= maxSliceAgeMs;
    });
    if (anyRecent) {
      kept[key] = paths;
    } else {
      pruned.push(key);
    }
  }

  return { strands: kept, pruned };
}
