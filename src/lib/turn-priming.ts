/**
 * Turn priming — deterministic, engineering-computed context for the chat
 * turn's system prompt.
 *
 * v0.9 (slice-level prompt freeze): the per-turn brief is GONE. The `Sent:`
 * timestamp, LLM-classified intent, emotional register and semantic strand
 * links no longer enter the prompt — the analyzer (analyzeTurn) still runs
 * every turn, but its output only feeds housekeeping decisions and agent.md.
 * What remains here is the SLICE-HEAD SNAPSHOT (`buildSliceHeadBlock`, the
 * "L3" block): every line anchors to the slice's start instant, so the
 * assembled system prompt stays byte-identical for the slice's whole life and
 * the provider's automatic prefix cache (DeepSeek) is reused across turns.
 * Precise "now" questions are answered by the currentTime tool instead of a
 * per-turn prompt timestamp.
 *
 * Everything here is pure: no LLM, no I/O.
 */
import { buildDateAnchors, normalizeLocale } from "@/lib/time/relative";

// ─── Emotional register ───────────────────────────────────────────────────

/**
 * The dominant emotional register of a user message, as read by the worker
 * analyzer. No longer injected into the prompt (v0.9) — the analyzer's output
 * still feeds housekeeping decisions and the agent.md record.
 */
export type EmotionalRegister =
  | "neutral"
  | "emotional"
  | "humorous"
  | "frustrated"
  | "excited";

/** The worker analyzer's read on the user's emotional state this turn. */
export interface EmotionalSignal {
  /** How much emotional weight the message carries. */
  intensity: "none" | "light" | "strong";
  /** The dominant register (normalized to "neutral" when absent). */
  register: EmotionalRegister;
  /** One short line on what the user is feeling and why ("" when neutral). */
  note: string;
}

// ─── Types ────────────────────────────────────────────────────────────────

/** A closed (or closing) previous slice — the continuity reference point. */
export interface PrevSliceRef {
  id: string;
  /** Slice focus (one-liner topic), if known. */
  focus: string;
  /** UTC ISO 8601 start. */
  start: string;
  /** UTC ISO 8601 end; falls back to `start` when absent. */
  end?: string;
}

export type ContinuityTier = "continuing" | "recent_return" | "cold" | "none";

export interface ContinuityInfo {
  tier: ContinuityTier;
  /** ms between the previous slice's reference time and now. */
  gapMs?: number;
  prevSlice?: PrevSliceRef;
}

/** How long a closed slice still counts as a "welcome back" (vs a cold start). */
export const CONTINUITY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── Time ────────────────────────────────────────────────────────────────

export interface LocalTimeInfo {
  /** e.g. "02 Aug 2026, 14:32" */
  local: string;
  /** e.g. "Asia/Shanghai" */
  zone: string;
  /** e.g. "UTC+8" ("" when the offset could not be derived) */
  offset: string;
  /** full UTC ISO 8601 */
  utc: string;
}

/**
 * Format a UTC ISO timestamp in the client's IANA timezone, with its UTC
 * offset. Invalid/unknown timezones degrade to UTC instead of throwing.
 */
export function formatLocalTime(nowIso: string, timezone: string): LocalTimeInfo {
  const d = new Date(nowIso);
  const zone = timezone && timezone.trim() ? timezone : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour12: false,
      hourCycle: "h23",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const local = `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;

    let offset = "";
    try {
      const tzParts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "longOffset",
      }).formatToParts(d);
      const name = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "";
      offset = name.replace("GMT", "UTC");
    } catch {
      // offset unsupported in this runtime — omit it
    }
    return { local, zone, offset, utc: d.toISOString() };
  } catch {
    return { local: d.toISOString(), zone: "UTC", offset: "", utc: d.toISOString() };
  }
}

/**
 * Classify the continuity stance against the previous slice.
 *
 * v0.9: the caller (housekeeping) always measures against the SLICE START
 * (`nowIso = slice.start`) and the newest slice closed before it, so the
 * resulting line is frozen for the slice's whole life. `isSameSlice`
 * ("continuing") is retained for API compatibility but no longer produced by
 * the prompt path.
 */
export function classifyContinuity(
  nowIso: string,
  prevSlice: PrevSliceRef | null,
  isSameSlice: boolean,
): ContinuityInfo {
  if (isSameSlice) return { tier: "continuing" };
  if (!prevSlice) return { tier: "none" };
  const refTime = prevSlice.end ?? prevSlice.start;
  const gapMs = Date.parse(nowIso) - Date.parse(refTime);
  if (Number.isNaN(gapMs)) return { tier: "cold", prevSlice };
  return gapMs < CONTINUITY_WINDOW_MS
    ? { tier: "recent_return", gapMs, prevSlice }
    : { tier: "cold", gapMs, prevSlice };
}

/** "1 hour ago", "3 days ago", "20 mins ago" — from a gap in ms. */
export function formatGap(gapMs: number): string {
  const mins = Math.max(1, Math.round(gapMs / 60_000));
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ─── Slice-head snapshot (L3) ────────────────────────────────────────────

/**
 * The continuity stance, framed as an analyst's note to the agent (about the
 * USER, not addressed to the agent): "the user's last session ended…".
 */
export function continuityLine(c: ContinuityInfo): string {
  if (c.tier === "continuing") {
    return "The user is mid-conversation — the recent turns above are the immediate context; continue naturally, no recall needed.";
  }
  if (c.tier === "recent_return" && c.prevSlice) {
    const gap = c.gapMs !== undefined ? formatGap(c.gapMs) : "recently";
    const focus = c.prevSlice.focus ? `, "${c.prevSlice.focus}"` : "";
    return `The user's last session ended ${gap} (slice ${c.prevSlice.id}${focus}) — this message is its direct continuation. Recall that slice FIRST, before any older threads.`;
  }
  if (c.tier === "cold" && c.prevSlice) {
    const gap = c.gapMs !== undefined ? formatGap(c.gapMs) : "a while ago";
    const focus = c.prevSlice.focus ? ` ("${c.prevSlice.focus}")` : "";
    return `The user's last session was ${gap}${focus}. No strong continuity — start fresh.`;
  }
  return "No past conversation yet.";
}

export interface SliceHeadInput {
  /** UTC ISO 8601 start of the slice — EVERY line anchors to this instant. */
  sliceStartIso: string;
  /** IANA timezone from the client, e.g. "Asia/Shanghai". */
  clientTimezone: string;
  /** UI locale ("zh" | "en") — the date-anchor table follows it. */
  locale?: string;
  /**
   * Continuity stance at slice birth — computed by housekeeping against
   * `sliceStartIso` and the newest slice closed before this one, so the line
   * is identical on every turn of the slice.
   */
  continuity: ContinuityInfo;
  /**
   * One-sentence summary of the card evolution that ran as this slice began
   * (persisted in the slice frontmatter at birth and replayed verbatim).
   */
  evolutionSummary?: string;
}

/**
 * Build the frozen slice-head snapshot block (the "L3" layer of the system
 * prompt): slice-start local time + date anchors + continuity stance +
 * (optional) birth-evolution summary + the drift hint. Deterministic in its
 * inputs — same slice, same bytes — which is what keeps the provider's
 * prefix cache warm across the slice's turns.
 */
export function buildSliceHeadBlock(input: SliceHeadInput): string {
  const t = formatLocalTime(input.sliceStartIso, input.clientTimezone);
  const offset = t.offset ? `, ${t.offset}` : "";
  const zh = normalizeLocale(input.locale) === "zh";

  const parts: string[] = [
    "## This slice — snapshot at its start",
    `- Slice started: ${t.local} (${t.zone}${offset}) · UTC ${t.utc}`,
    "- Slice ids are UTC labels (YYYY-MM-DD-HHMM; stored at memory/episodic/slices/YYYY/MM/DD/HHMM). The times in this block are already computed in the user's zone and in UTC.",
  ];

  // Precomputed date anchors — the model resolves "上周五" / "last Friday"
  // against this table instead of doing date arithmetic itself.
  const anchors = buildDateAnchors(input.sliceStartIso, input.clientTimezone, input.locale);
  if (anchors.length > 0) {
    parts.push(
      zh
        ? "- 日期锚点（“上周五”这类相对日期以此表为准，不要自行推算）："
        : `- Date anchors (resolve relative dates like "last Friday" from this table — never do date arithmetic yourself):`,
    );
    parts.push(anchors.map((a) => `    - ${a}`).join("\n"));
  }

  parts.push(`- Continuity: ${continuityLine(input.continuity)}`);

  // Frozen at slice birth (see SliceFrontmatter.evolution_summary) — the card
  // above already carries the change; this line just tells the agent why.
  if (input.evolutionSummary) {
    parts.push(
      `- The user card was updated just as this slice began: ${input.evolutionSummary}`,
    );
  }

  // The snapshot freezes the slice-start clock; precise "now" questions must
  // go through the currentTime tool instead of this (possibly stale) time.
  parts.push(
    `- The slice-start time above may already be tens of minutes old. Whenever a precise time matters ("now", "in a few minutes", something due today), call the currentTime tool first instead of trusting this snapshot.`,
  );

  // Time references in the reply belong to the user's clock, not UTC.
  parts.push(`Use the user's local time (${t.zone}) for any time references in your reply — not UTC.`);

  return parts.join("\n");
}
