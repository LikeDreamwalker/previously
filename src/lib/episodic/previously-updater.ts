/**
 * Card updater — applies the evolution agent's updated user-card (v4) with
 * mechanical enforcement.
 *
 * The Previously Agent outputs the FULL updated card text (capped, written with
 * a preserve-verbatim instruction). This module validates it, applies the
 * mechanical rules that the model shouldn't be trusted to self-enforce —
 * 7-day recent expiry, section caps, the Profile paragraph ceiling, and the
 * self-model anti-conflict backstop — then serializes the final card.
 *
 * Pure functions only — no I/O, no LLM calls.
 */
import {
  parseCard,
  serializeCard,
  stripInlineComments,
  CARD_RECENT_EXPIRY_DAYS,
  CARD_RECENT_MAX,
  CARD_SELF_MODEL_MAX,
  CARD_PROFILE_MAX_CHARS,
  type CardDocument,
} from "./previously-format";

export interface CardUpdateResult {
  content: string;
  changed: boolean;
  /** How many Recent items were dropped by the 7-day expiry. */
  droppedRecent: number;
}

/**
 * Hard self-model invariants the agent must not contradict without an explicit
 * `overrides:` marker. The prompt's delta rule is the primary guard; this code
 * backstop ensures a single bad line can never break core tool discipline.
 */
const SELF_MODEL_INVARIANTS: Array<{ re: RegExp; rule: string }> = [
  { re: /never\s+use\s+(the\s+)?recall/i, rule: "recall is the memory-search tool" },
  { re: /don'?t\s+(use|call)\s+(the\s+)?recall/i, rule: "recall is the memory-search tool" },
  { re: /never\s+read\s+(the\s+)?(memory|slices)/i, rule: "readSlice/recall are the memory tools" },
];

function contradictsInvariant(line: string): boolean {
  if (/\boverrides\s*[:=]/.test(line)) return false; // explicit user override
  return SELF_MODEL_INVARIANTS.some(({ re }) => re.test(line));
}

/**
 * Apply the evolution agent's updated card to the current one.
 *
 * @param previousContent The card currently on disk.
 * @param updatedCard     The agent's rewritten card (validated first; falls
 *                        back to the previous card if it doesn't parse).
 * @param sliceId         The slice the card belongs to.
 * @param nowIso          Clock anchor for the 7-day expiry (defaults to now).
 */
export function applyCardUpdate(
  previousContent: string,
  updatedCard: string,
  sliceId: string,
  nowIso = new Date().toISOString(),
): CardUpdateResult {
  const prevDoc = parseCard(previousContent);
  const updatedDoc = parseCard(updatedCard);
  // If the agent's rewrite didn't parse, keep the previous card untouched —
  // never re-stamp or rewrite it from a garbage output.
  if (!updatedDoc) {
    return { content: previousContent, changed: false, droppedRecent: 0 };
  }
  const doc: CardDocument = updatedDoc;

  doc.sliceId = sliceId;
  doc.updated = nowIso;

  // 1. Drop Recent items past the 7-day expiry window.
  const cutoff = new Date(nowIso);
  cutoff.setUTCDate(cutoff.getUTCDate() - CARD_RECENT_EXPIRY_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const recentBefore = doc.recent.length;
  doc.recent = doc.recent.filter((r) => !r.since || r.since >= cutoffDate);
  const droppedRecent = recentBefore - doc.recent.length;

  // 2. Cap Recent at the newest N (by `since`, descending).
  doc.recent = doc.recent.sort((a, b) => (a.since > b.since ? -1 : 1)).slice(0, CARD_RECENT_MAX);

  // 3. Cap the Profile paragraph.
  if (doc.profile.length > CARD_PROFILE_MAX_CHARS) {
    doc.profile = doc.profile.slice(0, CARD_PROFILE_MAX_CHARS).trim();
  }

  // 4. Self-model: strip comments, drop invariant-contradicting lines, cap.
  doc.selfModel = doc.selfModel
    .map((l) => stripInlineComments(l).trim())
    .filter((l) => l.length > 0 && !contradictsInvariant(l))
    .slice(0, CARD_SELF_MODEL_MAX);

  // 5. Identity head: cap.
  doc.identity = doc.identity.slice(0, 8);

  const content = serializeCard(doc);
  // `changed` = the card's SUBSTANCE changed (identity/profile/recent/self-model).
  // The sliceId/updated stamp always refreshes on a pass and is ignored here.
  const substance = (d: CardDocument | null) =>
    JSON.stringify({
      identity: d?.identity ?? [],
      profile: d?.profile ?? "",
      recent: d?.recent ?? [],
      selfModel: d?.selfModel ?? [],
    });
  const changed = substance(doc) !== substance(prevDoc);
  return { content, changed, droppedRecent };
}
