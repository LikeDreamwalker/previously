/**
 * Deterministic slice marking — the reliability backstop for close-marking.
 *
 * When the worker analyzer produces no `closed_marking` (call failure returns
 * EMPTY, or the model omits it), housekeeping fills focus/summary with a
 * deterministic mark derived from the slice's OWN turns. A closed slice with
 * content is never left dry: recall and the timeline both depend on non-empty
 * focus/summary to judge relevance.
 *
 * Pure — no I/O, no LLM.
 */
import type { TimeSlice } from "./types";

export interface SliceMark {
  focus: string;
  summary: string;
}

const OPENING_MAX = 60;

/**
 * Build a deterministic mark from a slice: focus = the opening line of the
 * first user turn (real signal), summary = turn count + tags. Honest for
 * trivial slices ("未标记话题") and useful for substantive ones.
 */
export function deterministicSliceMark(slice: TimeSlice): SliceMark {
  const firstUser = slice.turns.find((t) => t.role === "user");
  const opening = firstUser
    ? firstUser.content
        .trim()
        .split(/\n/)[0]
        .replace(/\s+/g, " ")
        .slice(0, OPENING_MAX)
    : "";

  const tags = slice.tags.length > 0 ? slice.tags.join("、") : "未标记话题";
  const focus = opening
    ? `用户提到：${opening}${opening.length >= OPENING_MAX ? "…" : ""}`
    : `会话（${tags}）`;
  const summary = `共 ${slice.turns.length} 轮，涉及 ${tags}。`;
  return { focus, summary };
}
