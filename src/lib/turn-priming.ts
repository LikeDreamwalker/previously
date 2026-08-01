/**
 * Turn priming — a deterministic, engineering-computed "brief" injected at the
 * top of every chat turn's system prompt.
 *
 * Everything here is pure: no LLM, no I/O. The caller (the housekeeping step)
 * supplies the message, timezone, start time, continuity context, and the
 * strand index; this module turns them into a short situational brief that tells
 * the model *what turn it is walking into*: the clock, whether this is a
 * continuing session / a recent return / a cold start, and which past threads
 * the message may touch.
 *
 * Continuity outranks semantics: when the previous slice is recent, the brief
 * tells the model to ground on it FIRST; strand matches are offered as
 * secondary and conditional ("only if actually relevant").
 */
import type { StrandIndex } from "@/lib/episodic";
export type { StrandIndex } from "@/lib/episodic";

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

export interface MatchedStrand {
  tag: string;
  occurrences: number;
  /** YYYY/MM/DD/HHMM of the most recent slice under this strand. */
  lastSeenPath: string;
  /** Slice paths (relative "YYYY/MM/DD/HHMM") under this strand, newest first. */
  slices: string[];
}

export interface PrimingInput {
  /** The user's latest message (for strand matching). */
  message: string;
  /** IANA timezone from the client, e.g. "Asia/Shanghai". */
  clientTimezone: string;
  /** UTC turn start, ISO 8601. */
  nowIso: string;
  continuity: ContinuityInfo;
  strands: StrandIndex;
  /** The current slice id — never suggested as a recall target. */
  excludeSliceId: string;
  /**
   * LLM-suggested strands for this turn (from the housekeeping analyze call),
   * with a one-line reason. When provided, the semantic section is built from
   * these (mapped to slice paths via the strand index); otherwise it falls back
   * to `matchStrands`.
   */
  semanticHint?: { strands: string[]; reason: string };
  /**
   * LLM-classified intent for this turn (what the user is trying to do),
   * from the housekeeping analyze call. Omitted when the call produced none.
   */
  intent?: { type: string; reason: string };
}

// ─── Constants / helpers ─────────────────────────────────────────────────

/** Tiny stoplist — universal words that would match almost anything. */
const STOP_TAGS = new Set([
  "test",
  "todo",
  "help",
  "问题",
  "测试",
  "帮助",
  "聊天",
  "什么",
]);

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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
 * Classify the turn's continuity stance from the previous slice.
 * `isSameSlice` means the recovered active slice is being continued directly
 * (no gap to reason about). Otherwise the gap is measured against the previous
 * slice's end (falling back to its start) and compared to
 * `CONTINUITY_WINDOW_MS`.
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

// ─── Strand matching ─────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count occurrences of a tag in the message (case-insensitive), capped at 3.
 * Latin tags use word boundaries (avoids "rust" matching inside "trust");
 * CJK/mixed tags use substring scans (Chinese has no word boundaries).
 */
function countTagMentions(message: string, tag: string): number {
  const lower = message.toLowerCase();
  const tagLower = tag.toLowerCase();
  if (/^[a-z0-9-]+$/.test(tagLower)) {
    const re = new RegExp(`\\b${escapeRegex(tagLower)}\\b`, "g");
    const match = lower.match(re);
    return Math.min(match ? match.length : 0, 3);
  }
  let count = 0;
  let idx = 0;
  while (count < 3) {
    const i = lower.indexOf(tagLower, idx);
    if (i === -1) break;
    count += 1;
    idx = i + tagLower.length;
  }
  return count;
}

/** Slice path "2026/06/22/1400" → epoch ms, parsed as UTC. */
function pathToMs(path: string): number {
  const m = path.match(/^(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return 0;
  const [, y, mo, d, hm] = m;
  const [hh, mm] = [hm.slice(0, 2), hm.slice(2)];
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
}

function recencyScore(lastSeenMs: number, nowMs: number): number {
  const days = (nowMs - lastSeenMs) / 86_400_000;
  if (days < 3) return 0.5;
  if (days < 14) return 0.3;
  if (days < 60) return 0.1;
  return 0;
}

/** "2026/07/24" → "Jul 24". */
function formatLastSeen(path: string): string {
  const m = path.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return `${month} ${Number(m[3])}`;
}

/**
 * Rank strands whose tag appears in the message, by (occurrences + specificity
 * + recency), capped at 3. Strands that only point at the current slice are
 * dropped — they are already surfaced as the current thread.
 */
export function matchStrands(
  message: string,
  strands: StrandIndex,
  opts: { excludeSliceId: string; nowIso: string },
): MatchedStrand[] {
  const nowMs = Date.parse(opts.nowIso);
  const excludeRel = opts.excludeSliceId.split("-").join("/");

  const scored: Array<{ score: number; strand: MatchedStrand }> = [];
  for (const [tag, paths] of Object.entries(strands)) {
    if (!tag || STOP_TAGS.has(tag)) continue;
    const occurrences = countTagMentions(message, tag);
    if (occurrences === 0) continue;

    const slices = [...paths]
      .filter((p) => p !== excludeRel)
      .sort((a, b) => b.localeCompare(a));
    if (slices.length === 0) continue;

    const lastSeenPath = slices[0];
    const specificity = tag.length >= 5 || tag.includes("-") ? 0.5 : 0;
    const recency = recencyScore(pathToMs(lastSeenPath), nowMs);
    scored.push({
      score: occurrences + specificity + recency,
      strand: { tag, occurrences, lastSeenPath, slices: slices.slice(0, 3) },
    });
  }

  scored.sort(
    (a, b) => b.score - a.score || b.strand.lastSeenPath.localeCompare(a.strand.lastSeenPath),
  );
  return scored.slice(0, 3).map((s) => s.strand);
}

/**
 * Map LLM-suggested strand NAMES to their slice paths via the strand index
 * (the LLM knows "which topics"; the engineering layer knows "where they are").
 * Names absent from the index, stopwords, and strands that only point at the
 * current slice are dropped. Newest-first, capped at 3.
 */
export function resolveSuggestedStrands(
  names: string[],
  strands: StrandIndex,
  excludeSliceId: string,
): MatchedStrand[] {
  const excludeRel = excludeSliceId.split("-").join("/");
  const seen = new Set<string>();
  const results: MatchedStrand[] = [];
  for (const name of names) {
    if (!name || seen.has(name) || STOP_TAGS.has(name)) continue;
    const paths = strands[name];
    if (!paths || paths.length === 0) continue;
    const slices = [...paths]
      .filter((p) => p !== excludeRel)
      .sort((a, b) => b.localeCompare(a));
    if (slices.length === 0) continue;
    seen.add(name);
    results.push({ tag: name, occurrences: 1, lastSeenPath: slices[0], slices: slices.slice(0, 3) });
  }
  results.sort((a, b) => b.lastSeenPath.localeCompare(a.lastSeenPath));
  return results.slice(0, 3);
}

// ─── Assembly ────────────────────────────────────────────────────────────

/**
 * The continuity stance, framed as an analyst's note to the agent (about the
 * USER, not addressed to the agent): "the user's last session ended…".
 */
function continuityLine(c: ContinuityInfo): string {
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

/**
 * Build the full priming block — an internal analyst's brief to the agent
 * about the user's turn (time, intent, continuity, semantic links), not a
 * user-facing greeting. Empty-safe: still a usable brief with no strands.
 */
export function buildTurnPriming(input: PrimingInput): string {
  const t = formatLocalTime(input.nowIso, input.clientTimezone);
  const offset = t.offset ? `, ${t.offset}` : "";

  const parts: string[] = [
    "## This turn — analysis",
    "Analyzed:",
    `- Sent: ${t.local} (${t.zone}${offset}) · UTC ${t.utc}`,
  ];

  // Intent — LLM-classified in housekeeping. Omitted entirely when the analyze
  // call didn't produce one (housekeeping failure handling is a separate TODO).
  if (input.intent?.type) {
    const reason = input.intent.reason ? ` — ${input.intent.reason}` : "";
    parts.push(`- Intent: ${input.intent.type}${reason}.`);
  }

  parts.push(`- Continuity: ${continuityLine(input.continuity)}`);

  // LLM-suggested strands are primary (they understand paraphrase / language);
  // the engineering vocabulary match is the fallback when the hint is empty.
  const hint = input.semanticHint;
  const matched =
    hint && hint.strands.length > 0
      ? resolveSuggestedStrands(hint.strands, input.strands, input.excludeSliceId)
      : matchStrands(input.message, input.strands, {
          excludeSliceId: input.excludeSliceId,
          nowIso: input.nowIso,
        });

  if (matched.length > 0) {
    const reason = hint?.reason ? ` — ${hint.reason}` : "";
    const lines = matched.map((m) => {
      const lastSeen = m.lastSeenPath ? ` (last seen ${formatLastSeen(m.lastSeenPath)})` : "";
      const slices = m.slices.length > 0 ? ` → ${m.slices.join(", ")}` : "";
      return `    - ${m.tag}${lastSeen}${slices}`;
    });
    parts.push(`- Semantic links (only if actually relevant)${reason}:`);
    parts.push(lines.join("\n"));
  }

  // Time references in the reply belong to the user's clock, not UTC.
  parts.push(`Use the user's local time (${t.zone}) for any time references in your reply — not UTC.`);

  return parts.join("\n");
}
