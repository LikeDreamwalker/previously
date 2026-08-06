/**
 * Tolerant numeric schemas for structured model output.
 *
 * Sub-agents (recall, webSearch) emit structured tool calls (recallReport,
 * searchReport). DeepSeek's worker models occasionally produce non-numeric
 * values for numeric fields — `confidence: NaN` on an empty result, a string
 * where a number was expected, or an out-of-range relevance. Without guard
 * rails, zod rejects the input and the AI SDK throws `InvalidToolInputError`,
 * which the executors either swallow (silent recall failure) or — worse —
 * let through `withStepTimeout` into workflow retries (webSearch).
 *
 * These schemas make numeric fields deterministic:
 * - `z.coerce.number()` coerces numeric strings ("0.8" → 0.8)
 * - `.catch(0)` turns NaN / null / unparseable into a safe default
 * - `.transform(clamp)` pins out-of-range values into [min, max] instead of
 *   silently zeroing a high relevance score
 *
 * The result: the structured tool call ALWAYS parses, so a malformed numeric
 * never becomes an InvalidToolInputError that blocks the turn.
 */
import { z } from "zod";

/** Coerced, NaN-safe, clamped number within [min, max]. */
export function tolerantNumber(min: number, max: number) {
  return z.coerce
    .number()
    .catch(0)
    .transform((n) => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min));
}

/** 0-1 confidence/relevance value. NaN, null, out-of-range all resolve safely. */
export const tolerantBounded01 = tolerantNumber(0, 1);

/**
 * Array of turn indices. Coerces each element to a number and DROPS members
 * that cannot be coerced (a string like "a3fk2w", NaN, null) — the index
 * list must only ever contain real, finite turn numbers, never a mangled 0.
 * A non-array input degrades to [].
 */
export const tolerantNumberArray = z
  .array(z.unknown())
  .catch([])
  .transform((arr) =>
    arr
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n)),
  );
