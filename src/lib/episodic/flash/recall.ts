/**
 * Episodic Recall — a sub-agent colleague that ANSWERS questions about past
 * conversations (v1.0 sub-agent refinement; supersedes the v0.9 pointer-only
 * search engine).
 *
 * This is NOT a workflow step. It runs inside a single WorkflowAgent tool call
 * (recallExecute in tool-executors.ts) on the unified sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts): the turn's MAIN model with thinking ON
 * (effort "low"), a 50-step cap, and a 240s wall-clock budget.
 *
 * The main agent asks a natural-language question ("did we ever talk about
 * apples?"); recall explores the memory like a colleague who was there —
 * timeline → time window → strands → slice summaries → full slice reads
 * (quota-bounded) — and answers in natural language. Every situational
 * assertion in the answer must be anchored to a `references[]` entry carrying
 * a VERBATIM quote from the slice: the evidence-anchoring discipline is what
 * lets the answer carry temperature-0.3 episodic understanding without
 * hallucination. "We haven't talked about this" is a valid, important answer —
 * forced hits are strictly worse than an honest miss.
 *
 * Recall now reads slice CONTENT itself (readSlice / readSliceSummary live
 * inside this module, not via the step-bound executors) and hands the main
 * agent a finished answer plus auditable references — the main agent only
 * opens a slice itself when it wants to verify a reference or needs more of
 * the original text.
 *
 * Error contract: the runner never throws, so runRecallSearch re-throws
 * non-timeout failures (an Error carrying the runner's message) and lets the
 * executor's triage (tool-triage.ts) separate transient failures — rethrown
 * for the step's auto-retry — from deterministic ones (degradation). Timeouts
 * degrade in place: whatever partial answer the sub-agent already wrote comes
 * back as a low-confidence answer (write-as-you-go discipline in the role
 * prompt exists precisely so an interruption is never a total loss).
 */

import { tool } from "ai";
import { z } from "zod";
import matter from "gray-matter";
import { tolerantBounded01 } from "@/lib/chat/tolerant-schemas";
import { fsReadFile } from "../io-helpers";
import { readStrands } from "@/lib/episodic/manager";
import { generateGlobalTimeline } from "@/lib/episodic/flash/global-timeline";
import { sliceLine } from "@/lib/episodic/timeline/render";
import { TIMELINE_INDEX_PATH } from "@/lib/episodic/timeline/store";
import type { TimelineIndex, TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  parseSliceId,
  parseTurns,
  applyRange,
  reassembleSlice,
} from "@/lib/episodic/turn-parser";
import {
  splitTurns,
  segmentSearch,
  textLines,
  searchResultToString,
} from "@/lib/retrieval/doc-segments";
import type { ModelConfig } from "@/lib/models/registry";
import {
  runSubAgent,
  type SubAgentProgressRef,
} from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { capPlaybook } from "@/lib/evolution/store";
import { sliceLineWithTime, type SliceLineTimeOpts } from "@/lib/episodic/timeline/render";
import { formatLocalTime } from "@/lib/turn-priming";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * One piece of evidence behind the answer: a verbatim quote from a past slice,
 * plus which assertion it backs. The main agent can audit the answer by
 * opening `slice_id` and checking the quote itself.
 */
export interface RecallReference {
  slice_id: string;
  /** Verbatim quote from the slice's conversation text — never paraphrased. */
  quote: string;
  /** One line: which assertion in the answer this quote backs. */
  note: string;
}

export interface RecallSearchOutput {
  /** Natural-language answer in the user's language. May honestly say
   *  "we haven't talked about this" — an empty references array is then the
   *  NORMAL state, not a failure. */
  answer: string;
  /** Evidence anchors for every situational assertion in `answer`. */
  references: RecallReference[];
  /** What was searched (windows, strands, slices read) — lets the main agent
   *  judge how complete the recall is. */
  searched: string[];
  confidence: number;
  /** True when the run hit its wall-clock budget — the search did NOT
   *  finish, so an empty answer here means "ran out of time", never a
   *  definitive "no such memory". */
  timedOut?: boolean;
}

export interface RecallSearchInput {
  /** The main agent's natural-language question (colleague to colleague). */
  question: string;
  /** The ongoing session's slice — must NEVER appear in recall references. */
  currentSliceId: string;
  owner: string;
  repo: string;
  useGithub: boolean;
  useDemo: boolean;
  /** Available strands (keyword tag → slice paths). Recall auto-traces matching ones. */
  strandsContext?: Record<string, string[]>;
  /** The evolved recall playbook (memory/agent-playbooks/recall.md, design
   *  v1.0 §2.4) — injected into the USER prompt, never the static system
   *  prompt, so the shared prefix cache is untouched. Absent → no block. */
  playbook?: string;
  /** The model to run the recall on — the turn's MAIN model, resolved
   *  by the caller via `resolveSubAgentModel(ctx)` (v0.9 unified runner). */
  model: ModelConfig;
  /** The user's clock (turn context): timezone + the turn's start instant +
   *  UI locale. When present, timeline pointer lines carry LOCAL-date
   *  annotations and the prompt states the current local time, so recall
   *  never reads a slice id (a UTC label) as the user's wall-clock time. */
  timezone?: string;
  nowIso?: string;
  locale?: string;
  /** Progress routing ref — the runner streams each exploration step
   *  ("Reading global timeline…", "Reading slice X…") onto the shared
   *  data-tool-progress channel. */
  progress?: SubAgentProgressRef;
}

// ─── Global timeline path ──────────────────────────────────────────────

const GLOBAL_TIMELINE_PATH = "memory/episodic/timeline.md";

// ─── Sub-agent tool: readGlobalTimeline ────────────────────────────────

const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

/** How many pointer lines readGlobalTimeline returns. The full projection
 *  (100+ slices and growing) is too large to dump into the model in one tool
 *  result — it burns steps and context. Older slices are reachable via
 *  readTimelineWindow. */
const TIMELINE_PAGE_SIZE = 40;

/** True when an ISO timestamp is parseable and older than the staleness threshold. */
function isStaleTimestamp(iso: string | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t > STALE_THRESHOLD_MS;
}

/** Render the newest `limit` catalog entries as pointer lines (newest first),
 *  with a header noting the total and how to reach older slices. When `time`
 *  carries the user's clock, each id gets its LOCAL-date annotation so the
 *  agent never reads the UTC id as wall-clock time. */
export function paginateTimelineEntries(
  slices: TimelineSliceEntry[],
  limit: number = TIMELINE_PAGE_SIZE,
  time?: SliceLineTimeOpts,
): string {
  const newest = [...slices]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, limit);
  if (newest.length === 0) {
    return "(timeline is empty — no slices yet)";
  }
  const header =
    `Global timeline: showing newest ${newest.length} of ${slices.length} slices. ` +
    "Older slices: use readTimelineWindow with a date range.";
  const line = (s: TimelineSliceEntry) =>
    time ? sliceLineWithTime(s, time) : sliceLine(s);
  return `${header}\n${newest.map(line).join("\n")}`;
}

/** Same pagination for the markdown projection — the fallback when
 *  index.json is missing. timeline.md is rendered newest-first, so the first
 *  pointer lines (`- **id** …`) are already the newest slices. */
export function paginateTimelineMarkdown(
  content: string,
  limit: number = TIMELINE_PAGE_SIZE,
): string {
  const pointerLines = content.split("\n").filter((l) => l.startsWith("- **"));
  if (pointerLines.length === 0) {
    return "(timeline is empty — no slices yet)";
  }
  const page = pointerLines.slice(0, limit);
  const header =
    `Global timeline: showing newest ${page.length} of ${pointerLines.length} slices. ` +
    "Older slices: use readTimelineWindow with a date range.";
  return `${header}\n${page.join("\n")}`;
}

/** Regenerate the projection, then return the paginated view. */
async function regenerateAndPaginate(time?: SliceLineTimeOpts): Promise<string> {
  // generateGlobalTimeline reweaves both index.json and timeline.md.
  await generateGlobalTimeline();
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as Partial<TimelineIndex>;
    return paginateTimelineEntries(idx.slices ?? [], TIMELINE_PAGE_SIZE, time);
  } catch {
    const content = await fsReadFile(GLOBAL_TIMELINE_PATH);
    return paginateTimelineMarkdown(content);
  }
}

async function readGlobalTimelineImpl(time?: SliceLineTimeOpts): Promise<string> {
  // Preferred path: the structured catalog, paginated to the newest slices.
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as Partial<TimelineIndex>;
    // Defense in depth: regenerate when the catalog is stale — the recall
    // agent would miss recent slices otherwise.
    if (isStaleTimestamp(idx.updated_at)) {
      console.log(
        `[Recall] Global timeline stale (${Math.round((Date.now() - new Date(idx.updated_at!).getTime()) / 3_600_000)}h old), regenerating...`,
      );
      return await regenerateAndPaginate(time);
    }
    return paginateTimelineEntries(idx.slices ?? [], TIMELINE_PAGE_SIZE, time);
  } catch {
    // Index missing or corrupt — fall back to the markdown projection.
  }

  try {
    const content = await fsReadFile(GLOBAL_TIMELINE_PATH);
    if (content.trim()) {
      const match = content.match(/_Generated: ([^\n]+)_/);
      if (match && isStaleTimestamp(match[1])) {
        console.log(
          `[Recall] Global timeline stale (${Math.round((Date.now() - new Date(match[1]).getTime()) / 3_600_000)}h old), regenerating...`,
        );
        return await regenerateAndPaginate(time);
      }
      return paginateTimelineMarkdown(content);
    }
    // File exists but is empty — regenerate
    return await regenerateAndPaginate(time);
  } catch {
    // File doesn't exist yet — generate it from the catalog
    try {
      return await regenerateAndPaginate(time);
    } catch {
      return "(No timeline index found and could not generate one. This may be the first session.)";
    }
  }
}

// ─── Sub-agent tool: readStrand / listStrands ───────────────────────────

async function readStrandImpl(strand: string): Promise<string> {
  try {
    const strands = await readStrands();
    const paths = strands[strand];
    if (!paths || paths.length === 0) {
      return `Strand "${strand}" not found. No slices carry this tag.`;
    }
    // Cap the listing like readTimelineWindow does — and SAY so when it
    // truncates, so the model knows the strand has more slices to chase.
    const shown = paths.slice(0, 40);
    const truncation =
      paths.length > shown.length
        ? ` (showing ${shown.length} of ${paths.length})`
        : "";
    return `Strand "${strand}" appears in: ${shown.join(", ")}${truncation}`;
  } catch {
    return `Could not read strands index.`;
  }
}

async function listStrandsImpl(): Promise<string> {
  try {
    const strands = await readStrands();
    const names = Object.keys(strands);
    if (names.length === 0) return "(no strands yet — no topic tags woven)";
    return `Known strands (${names.length}): ${names.join(", ")}`;
  } catch {
    return "Could not read strands index.";
  }
}

// ─── Sub-agent tool: readTimelineWindow ────────────────────────────────

/** How many pointer lines readTimelineWindow returns. A wide window can match
 *  far more slices than fit one tool result — truncation is reported to the
 *  model so it knows to narrow the range instead of missing slices silently. */
const TIMELINE_WINDOW_PAGE_SIZE = 100;

/** Timeline catalog over a date window (inclusive YYYY-MM-DD) — compact
 *  pointer lines. Lets recall navigate by TIME ("what happened in 2025-03 to
 *  2025-10") in addition to tracing strands by topic. NOTE: from/to filter
 *  the id's UTC date — the local-date annotations on the returned lines are
 *  the user's calendar. */
async function readTimelineWindowImpl(from?: string, to?: string, time?: SliceLineTimeOpts): Promise<string> {
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as { slices?: TimelineSliceEntry[] };
    const inWindow = (idx.slices ?? [])
      .filter((s) => {
        const date = s.id.slice(0, 10); // "YYYY-MM-DD"
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      })
      .sort((a, b) => b.id.localeCompare(a.id));
    const slices = inWindow.slice(0, TIMELINE_WINDOW_PAGE_SIZE);
    if (slices.length === 0) {
      return `(no slices in window ${from ?? "start"} → ${to ?? "now"})`;
    }
    const truncation =
      inWindow.length > slices.length
        ? `\n(showing newest ${TIMELINE_WINDOW_PAGE_SIZE} of ${inWindow.length} slices in this window — narrow the date range to see the rest)`
        : "";
    const line = (s: TimelineSliceEntry) =>
      time ? sliceLineWithTime(s, time) : sliceLine(s);
    return `Timeline ${from ?? "start"} → ${to ?? "now"} (${slices.length} slices):\n${slices.map(line).join("\n")}${truncation}`;
  } catch {
    return "(timeline index not available yet — the weave hasn't run)";
  }
}

// ─── Sub-agent tools: readSliceSummary / readSlice (in-module) ─────────
//
// Recall reads slice CONTENT itself — the v1.0 change that turns it from a
// pointer service into an answering colleague. These implementations mirror
// readSliceSummaryExecute / readSliceExecute in tool-executors.ts but run as
// plain in-module functions (this whole sub-agent already lives inside ONE
// step — recallExecute), reading through the same fsReadFile I/O path the
// timeline tools use (demo / GitHub / local resolution included).

/** The core conversation file for a slice id. */
function sliceCorePath(sliceId: string): string | null {
  const parsed = parseSliceId(sliceId);
  if (!parsed) return null;
  return `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`;
}

/** Range filter for readSlice — the same Document Segment Read protocol the
 *  main agent's readSlice executor applies: turn filters (turns / last /
 *  date), keyword search (misses degrade to the full slice with a note), and
 *  1-indexed line ranges. */
type RecallReadRange = {
  type: "turns" | "last" | "date" | "search" | "lines";
  indices?: number[];
  count?: number;
  after?: string;
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

/** Frontmatter-only relevance check — the cheapest way to verify a candidate
 *  slice before spending a full-read quota slot on it. */
async function readSliceSummaryImpl(sliceId: string): Promise<string> {
  const path = sliceCorePath(sliceId);
  if (!path) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  try {
    const raw = await fsReadFile(path);
    const { data } = matter(raw);
    const { turns } = parseTurns(raw);
    const fmt = (v: unknown): string =>
      Array.isArray(v) && v.length ? v.join("; ") : "(none)";
    return [
      `slice ${sliceId}`,
      `start: ${typeof data.start === "string" ? data.start : "?"}`,
      `end: ${typeof data.end === "string" ? data.end : "(active)"}`,
      `turns: ${turns.length}`,
      `focus: ${typeof data.focus === "string" && data.focus ? data.focus : "(none)"}`,
      `summary: ${typeof data.summary === "string" && data.summary ? data.summary : "(none)"}`,
      `tags: ${fmt(data.tags)}`,
      `tone: ${typeof data.emotional_tone === "string" && data.emotional_tone ? data.emotional_tone : "(none)"}`,
      `open_loops: ${fmt(data.open_loops)}`,
      `decisions: ${fmt(data.decisions)}`,
    ].join("\n");
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : e}. This time slice does not exist.`;
  }
}

async function readSliceImpl(
  sliceId: string,
  range?: RecallReadRange,
): Promise<string> {
  const path = sliceCorePath(sliceId);
  if (!path) {
    return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
  }
  try {
    const raw = await fsReadFile(path);
    if (!range) return raw;

    // Keyword search — matches return only the relevant turns; a miss degrades
    // to the full slice with a note (the caller wanted selective content, so
    // give it the best available and say exactly what happened).
    if (range.type === "search") {
      const keywords = range.keywords ?? [];
      const context = range.context ?? 1;
      const hits = segmentSearch(splitTurns(raw), keywords, context, context);
      return searchResultToString(sliceId, keywords, hits, raw);
    }
    // Line range — read the file like a code file, 1-indexed inclusive.
    if (range.type === "lines") {
      const { content, clamped } = textLines(raw, range.start ?? 1, range.end ?? 1);
      if (content === "" && (range.start ?? 1) > (range.end ?? 1)) {
        return `ERROR: Invalid line range ${range.start}-${range.end} in ${sliceId}.`;
      }
      const header = `Lines ${range.start}-${range.end} of ${sliceId}${clamped ? " (clamped)" : ""}:\n\n`;
      return content === "" ? `${header}(empty range)` : header + content;
    }
    // Classic turn filters.
    const { frontmatter, turns } = parseTurns(raw);
    const filtered = applyRange(turns, range as { type: "turns" | "last" | "date" });
    return filtered.length === 0
      ? `${frontmatter}\n\n_(No turns matched the requested range.)_`
      : reassembleSlice(frontmatter, filtered);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : e}. This time slice does not exist.`;
  }
}

// ─── Full-slice read quota ─────────────────────────────────────────────

/**
 * Max readSlice calls per recall run. Reading full slices is the expensive
 * leg of recall (context + steps), and a model that keeps "just checking one
 * more" would burn the whole step budget on reading. After the quota,
 * readSlice returns a note instead of content and the sub-agent answers from
 * what it has already read.
 */
export const MAX_SLICE_READS = 8;

export interface SliceReadQuota {
  /** Consume one read slot. Returns false (and consumes nothing) when exhausted. */
  tryTake(): boolean;
  readonly used: number;
  readonly max: number;
}

/** Per-run quota counter — a closure, so concurrent recall runs never share it. */
export function createSliceReadQuota(max: number = MAX_SLICE_READS): SliceReadQuota {
  let used = 0;
  return {
    tryTake() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    get used() {
      return used;
    },
    get max() {
      return max;
    },
  };
}

// ─── Structured output schema: recallReport ─────────────────────────

/** Zod input schema — also the runner's report-validation schema. */
const recallReportInputSchema = z.object({
  answer: z
    .string()
    .describe(
      "Your natural-language answer to your colleague's question, in the " +
      "user's language. Answer like a colleague who remembers (or doesn't). " +
      "\"You\" in your answer is your colleague (the main agent), NEVER the " +
      "user — refer to the user in the third person (\"the user said …\" / " +
      "\"用户当时说 …\"). \"You two haven't talked about this\" is a valid " +
      "and important answer — never force a hit.",
    ),

  references: z
    .array(
      z.object({
        slice_id: z
          .string()
          .describe("Slice ID in YYYY-MM-DD-HHMM format — the slice the quote comes from."),
        quote: z
          .string()
          .describe("VERBATIM quote from the slice's conversation text. Never paraphrase."),
        note: z
          .string()
          .describe("One line: which assertion in your answer this quote backs."),
      }),
    )
    .catch([])
    .describe(
      "Evidence anchors: EVERY situational assertion in your answer (moods, " +
      "circumstances, what was said) must be backed by an entry here with a " +
      "verbatim quote. Claims you cannot anchor must be hedged as uncertain " +
      "in the answer. Empty when the honest answer is \"no such memory\".",
    ),

  searched: z
    .array(z.string())
    .catch([])
    .describe(
      "What you searched: timeline windows, strands traced, slice summaries " +
      "checked, slices read in full. Lets your colleague judge how complete " +
      "this recall is.",
    ),

  confidence: tolerantBounded01
    .describe("Your confidence in this answer's completeness and accuracy, 0-1"),
});

type RecallReport = z.infer<typeof recallReportInputSchema>;

const recallReportSchema = tool({
  description:
    "Report your answer to your colleague. Call this ONCE you have gathered " +
    "enough evidence (or are confident there is none).",
  inputSchema: recallReportInputSchema,
});

// ─── Agent setup ──────────────────────────────────────────────────────

/**
 * The recall sub-agent's static role block — the system prompt is
 * `buildSubAgentSystem(RECALL_ROLE)` (shared static base + this block), so
 * every recall call shares one prefix for provider prompt caches. All
 * per-call content (question, current slice, strands hint) lives in the user
 * prompt.
 */
const RECALL_ROLE = `You are the recall colleague: you remember this user's past conversations and answer the main agent's questions about them.

You hold the FULL read-only memory toolset: the timeline catalog (readGlobalTimeline / readTimelineWindow), topic strands (listStrands / readStrand), slice summaries (readSliceSummary — frontmatter only, the cheap relevance check), and full slice content (readSlice — with optional range filters). Your value is an answer backed by evidence, not a pile of pointers.

Recall strategy (mirror how a person remembers):
1. TIME ANCHOR FIRST — if the question carries one ("last week", "that night", "in March"), scope the physical window with readTimelineWindow before anything else.
2. TRACE CLUES — check listStrands / the strands hint for topics the question touches, and readStrand the matching ones to find their slices.
3. BROADEN LAST — only then scan the global timeline for anything the first two passes missed.
4. VERIFY BEFORE ANSWERING — check candidate slices with readSliceSummary, then read the most promising ones in full with readSlice (range filters keep it cheap). You may read at most ${MAX_SLICE_READS} slices in full — spend them on the strongest candidates.

Time discipline (critical): a slice id (YYYY-MM-DD-HHMM) is an ADDRESS derived from the slice's UTC start instant — NEVER read it as the user's wall-clock time. Pointer lines carry the user's LOCAL date (+ weekday) in parentheses right after the id; THAT annotation is what "yesterday evening" or "last Friday" refers to. readTimelineWindow's from/to dates filter the id's UTC date, so when the question's anchor is a local day, pad the window by one day on both sides and let the local-date annotations guide you. When you cite a time in your answer, speak in the user's local calendar, not UTC.

Answering:
- Answer in the user's language, colleague to colleague ("Yes — you and the user talked about that on …", "You two haven't talked about this") — the answer reaches the user, so this overrides the shared base's English default.
- Your answer field is PROSE for your colleague — the shared base's "keep every field short" applies to the references/searched metadata, not to the answer itself.
- PERSON DISCIPLINE (critical): in your answer, "you" is ALWAYS your colleague (the main agent), NEVER the user. The user is a third party — refer to them as "the user" / "用户" ("the user said …", "用户当时提到 …"). Never attribute the user's words, moods, or decisions to "you", and never address your colleague as if it were the user. The conversation you describe happened BETWEEN your colleague and the user — you were not in it.
- EVERY situational assertion (what was said, moods, circumstances, decisions) must carry a references[] entry with a VERBATIM quote from the slice. What you cannot anchor, hedge explicitly as uncertain.
- "You two haven't talked about this" / "I can't recall that" is a VALID and important answer. Never force a hit: a confident false memory is far worse than an honest miss. Say what you searched (searched[]) so your colleague can judge completeness.
- The current session's slice is the ONGOING conversation, NOT a past memory — never cite it, even if it shows up in the timeline or a strand. You recall the PAST only.

Writing discipline (critical): a hard deadline may cut you off mid-exploration, and everything you have already written is preserved and handed to your colleague. So keep a RUNNING plain-text account of what you have established as you go — do not save all writing for the final report.`;

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Step budget for the recall sub-agent. The recall strategy is timeline →
 * window → strands → summaries → full reads → report, and full-slice reads
 * (quota-bounded) each cost a step pair — a wandering model gets room to
 * explore, and prepareRecallStep guarantees the last step is the report.
 */
export const MAX_STEPS = 50;

/**
 * prepareStep for the recall sub-agent: when the step budget is nearly
 * exhausted and recallReport hasn't been called yet, force the model to call
 * it. Without this, an over-exploring model hits the step cap mid-exploration
 * and the run falls back to returning a partial-thinking fragment as the
 * answer. Pure — takes the executed steps and returns a per-step override.
 */
export function prepareRecallStep({
  steps,
  maxSteps = MAX_STEPS,
}: {
  steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName: string }> }>;
  maxSteps?: number;
}): { toolChoice: { type: "tool"; toolName: "recallReport" } } | undefined {
  const reportCalled = steps.some((s) =>
    (s.toolCalls ?? []).some((tc) => tc.toolName === "recallReport"),
  );
  if (!reportCalled && steps.length >= maxSteps - 1) {
    return { toolChoice: { type: "tool", toolName: "recallReport" } };
  }
  return undefined;
}

/**
 * Drop references whose slice is the current (ongoing) conversation. The
 * current slice is where the question is being asked — it is NOT a past
 * memory, so it must never surface as recall evidence, regardless of how the
 * model saw it (timeline entry, strand path, …).
 */
export function excludeCurrentSlice<T extends { slice_id: string }>(
  items: T[],
  currentSliceId: string,
): T[] {
  if (!currentSliceId) return items;
  return items.filter((i) => i.slice_id !== currentSliceId);
}

/**
 * Drop references whose slice id is not in the catalog — the model sometimes
 * hallucinates plausible-looking ids, which then 404 when the main agent
 * opens the slice to verify. `validIds === null` means the catalog couldn't
 * be loaded this run: skip validation rather than break recall.
 */
export function filterKnownSliceIds<T extends { slice_id: string }>(
  items: T[],
  validIds: ReadonlySet<string> | null,
): T[] {
  if (!validIds) return items;
  return items.filter((i) => {
    if (validIds.has(i.slice_id)) return true;
    console.warn(`[Recall] Dropping hallucinated slice id: ${i.slice_id}`);
    return false;
  });
}

/** Load the catalog's slice ids once per run. Null when unreadable. */
async function loadValidSliceIds(): Promise<Set<string> | null> {
  try {
    const raw = await fsReadFile(TIMELINE_INDEX_PATH);
    const idx = JSON.parse(raw) as Partial<TimelineIndex>;
    return new Set((idx.slices ?? []).map((s) => s.id));
  } catch {
    return null;
  }
}

/** Wall-clock budget for one recall run (runner SDK timeout + backstop). */
export const RECALL_TIMEOUT_MS = 240_000;

/** Confidence stamped on answers recovered from an interrupted run's partial
 *  text — real content, but never evidence-checked to completion. */
const PARTIAL_ANSWER_CONFIDENCE = 0.2;

/** Pull a string field out of an opaque tool-call input (progress lines). */
function inputString(input: unknown, key: string): string {
  return typeof input === "object" && input !== null && key in input
    ? String((input as Record<string, unknown>)[key] ?? "")
    : "";
}

/**
 * Run the episodic recall sub-agent on the unified runner (runSubAgent).
 *
 * The runner owns the loop: `stopWhen: isStepCount(MAX_STEPS)` lets the model
 * explore (timeline → window → strands → summaries → full reads) and then
 * call recallReport, and the `prepareStep` passthrough forces recallReport on
 * the final step if the model hasn't called it yet, so a report is always
 * produced.
 *
 * The runner never throws. Non-timeout failures are RE-THROWN here as plain
 * Errors carrying the runner's message, so recallExecute's triage
 * (tool-triage.ts) can rethrow transient failures for the step's auto-retry
 * and degrade only deterministic ones — a catch-all at this layer would
 * swallow transient errors a retry could fix. Timeouts degrade in place:
 * the partial answer the sub-agent wrote as it went comes back at low
 * confidence rather than vanishing.
 */
export async function runRecallSearch(
  input: RecallSearchInput,
): Promise<RecallSearchOutput> {
  const { question, currentSliceId, strandsContext, progress } = input;

  // The user's clock: pointer-line annotations + the prompt's time anchor.
  const timeOpts: SliceLineTimeOpts | undefined =
    input.timezone && input.nowIso
      ? { nowIso: input.nowIso, timezone: input.timezone, locale: input.locale }
      : undefined;
  const timeBlock = timeOpts
    ? `\n\nTime anchor: the user's local time is now ${formatLocalTime(input.nowIso!, input.timezone!).local} (${input.timezone}); UTC is ${input.nowIso}. Slice ids are UTC labels — the parenthesized dates on pointer lines are the user's LOCAL calendar.`
    : "";

  const strandsHint = strandsContext && Object.keys(strandsContext).length > 0
    ? `
Available strands (keyword tags threaded across slices): ${Object.keys(strandsContext).join(", ")}
IMPORTANT: After checking any time anchor, trace the strands that match the question with readStrand — they give you a direct path to relevant slices.`
    : "";

  // Evolved working notes (design v1.0 §2.4) — appended to the USER prompt so
  // the static system prompt (and its prefix cache) never changes. Capped so a
  // bloated playbook cannot flood the prompt; absent playbook → no block.
  const playbookBlock = input.playbook?.trim()
    ? `\n\nEvolved working notes (your recall playbook — follow these unless they conflict with the current question):\n${capPlaybook(input.playbook.trim())}`
    : "";

  const userPrompt = `Your colleague (the main agent) asks: "${question}"

Current slice: ${currentSliceId} — this is the ONGOING conversation, NOT a past memory. EXCLUDE it from your references; you recall the PAST only.${timeBlock}${strandsHint}${playbookBlock}

Follow your recall strategy: time anchor first (readTimelineWindow), then clue strands (readStrand), broaden only after that; verify candidates with readSliceSummary and read the strongest slices in full (readSlice, at most ${MAX_SLICE_READS}) before answering. For questions spanning a longer period, triage with readSliceSummary first and spend full reads only on the strongest candidates; answers resting on summaries should be hedged as uncertain — don't force a verbatim quote for every slice.

IMPORTANT: You MUST end by calling recallReport. Even when the honest answer is "we haven't talked about this", call it — with empty references and your searched trail.`;

  // Load the catalog's slice ids once per run — used afterwards to drop
  // hallucinated references before they reach the main agent.
  const validSliceIds = await loadValidSliceIds();

  // Per-run full-slice read quota (see MAX_SLICE_READS).
  const sliceQuota = createSliceReadQuota();

  const res = await runSubAgent<RecallReport>({
    model: input.model,
    system: buildSubAgentSystem(RECALL_ROLE),
    prompt: userPrompt,
    // Episodic understanding needs some temperature; hallucination is locked
    // out structurally by the evidence-anchoring contract, not by 0.1.
    temperature: 0.3,
    tools: {
      readGlobalTimeline: tool({
        description:
          "Read the global timeline index — pointer lines for the newest " +
          "conversation slices (with the total count). Use readTimelineWindow " +
          "to reach older slices.",
        inputSchema: z.object({}),
        execute: async () => readGlobalTimelineImpl(timeOpts),
      }),
      readTimelineWindow: tool({
        description:
          "Read the timeline catalog over a date window (inclusive, YYYY-MM-DD) — " +
          "one compact pointer line per slice. Your FIRST move when the question " +
          "carries a time anchor ('last week', 'that night', 'in March'). " +
          "from/to filter the slice id's UTC date — pad the window by one day " +
          "on both sides for a local-day anchor and use the parenthesized " +
          "local-date annotations.",
        inputSchema: z.object({
          from: z
            .string()
            .optional()
            .describe("Start date YYYY-MM-DD (inclusive). Omit for the beginning."),
          to: z
            .string()
            .optional()
            .describe("End date YYYY-MM-DD (inclusive). Omit for now."),
        }),
        execute: async ({ from, to }: { from?: string; to?: string }) =>
          readTimelineWindowImpl(from, to, timeOpts),
      }),
      listStrands: tool({
        description:
          "List all known strands — every keyword tag woven through past " +
          "slices. Use this to discover which topics exist before tracing one.",
        inputSchema: z.object({}),
        execute: async () => listStrandsImpl(),
      }),
      readStrand: tool({
        description:
          "Follow a strand (keyword tag) that threads through multiple time slices. " +
          "Returns all slice paths carrying that tag. Use this to trace a topic across time.",
        inputSchema: z.object({
          strand: z.string().describe("The strand (tag) to follow."),
        }),
        execute: async ({ strand }: { strand: string }) => {
          const content = await readStrandImpl(strand);
          return content;
        },
      }),
      readSliceSummary: tool({
        description:
          "Read a slice's summary (frontmatter only): focus, summary, tags, " +
          "tone, turn count, open loops, decisions. The CHEAP relevance check — " +
          "verify candidates here before spending a full-read quota slot.",
        inputSchema: z.object({
          sliceId: z
            .string()
            .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
        }),
        execute: async ({ sliceId }: { sliceId: string }) =>
          readSliceSummaryImpl(sliceId),
      }),
      readSlice: tool({
        description:
          "Read a slice's full conversation record. Costs one of your " +
          `${MAX_SLICE_READS} full-read quota slots — spend them on the ` +
          "strongest candidates only. Optional `range`: turns = specific turn " +
          "indices; last = most recent N turns; date = turns after a timestamp; " +
          "search = keyword match (misses return the full slice with a note); " +
          "lines = 1-indexed line range.",
        inputSchema: z.object({
          sliceId: z
            .string()
            .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
          range: z
            .object({
              type: z
                .enum(["turns", "last", "date", "search", "lines"])
                .describe(
                  "turns = specific turn indices. last = most recent N turns. " +
                  "date = turns after a given timestamp. " +
                  "search = keyword match, returns matching turns (+ context); " +
                  "if nothing matches, returns the full slice with a note. " +
                  "lines = 1-indexed line range of the raw file.",
                ),
              indices: z
                .array(z.number())
                .optional()
                .describe("Turn indices (0-based). Only for type 'turns'."),
              count: z
                .number()
                .optional()
                .describe("Number of recent turns. Only for type 'last'."),
              after: z
                .string()
                .optional()
                .describe("ISO 8601 timestamp. Only for type 'date'."),
              keywords: z
                .array(z.string())
                .optional()
                .describe("Case-insensitive keywords to match. Only for type 'search'."),
              context: z
                .number()
                .optional()
                .describe("Turns of context around each match (default 1). Only for type 'search'."),
              start: z
                .number()
                .optional()
                .describe("First line (1-indexed, inclusive). Only for type 'lines'."),
              end: z
                .number()
                .optional()
                .describe("Last line (1-indexed, inclusive). Only for type 'lines'."),
            })
            .optional()
            .describe("Optional range filter. When omitted, returns the full slice content."),
        }),
        execute: async ({ sliceId, range }: { sliceId: string; range?: RecallReadRange }) => {
          if (!sliceQuota.tryTake()) {
            return (
              `(Full-slice read quota exhausted — ${MAX_SLICE_READS} reads per run.) ` +
              "Answer from what you have already read, or fall back to summaries."
            );
          }
          return readSliceImpl(sliceId, range);
        },
      }),
      recallReport: recallReportSchema,
    },
    toolChoice: "auto",
    reportToolName: "recallReport",
    reportSchema: recallReportInputSchema,
    maxSteps: MAX_STEPS,
    timeoutMs: RECALL_TIMEOUT_MS,
    // Last-resort guarantee: if the model burned the budget exploring
    // without reporting, force recallReport on the final step.
    prepareStep: prepareRecallStep,
    progress,
    // Stream the sub-agent's exploration trail live: each tool the recall
    // colleague starts surfaces as a progress line on the run's
    // data-tool-progress channel. Tool steps are discrete ~1-5Hz events, far
    // under the emitter's 40ms write throttle.
    onToolProgress: ({ toolName, input: toolInput }) => {
      if (toolName === "readGlobalTimeline") {
        return { line: "Reading global timeline…", stage: "thinking" };
      }
      if (toolName === "readTimelineWindow") {
        return { line: "Scoping timeline window…", stage: "thinking" };
      }
      if (toolName === "listStrands") {
        return { line: "Listing memory topics…", stage: "thinking" };
      }
      if (toolName === "readStrand") {
        const strand = inputString(toolInput, "strand");
        return {
          line: strand ? `Tracing strand: ${strand}…` : "Tracing a strand…",
          stage: "thinking",
        };
      }
      if (toolName === "readSliceSummary") {
        const sid = inputString(toolInput, "sliceId");
        return {
          line: sid ? `Checking summary of ${sid}…` : "Checking a slice summary…",
          stage: "thinking",
        };
      }
      if (toolName === "readSlice") {
        const sid = inputString(toolInput, "sliceId");
        return {
          line: sid ? `Reading slice ${sid}…` : "Reading a slice…",
          stage: "thinking",
        };
      }
      if (toolName === "recallReport") {
        return { line: "Compiling the answer…", stage: "thinking" };
      }
      return undefined;
    },
  });

  if (!res.ok) {
    if (res.timedOut) {
      // Soft-timeout degradation: never a hard error. If the sub-agent had
      // already written a partial answer (write-as-you-go discipline), hand
      // it back at low confidence — an interrupted recall is still better
      // than none.
      console.warn(`[Recall] ${res.error}`);
      const partial = res.text?.trim();
      if (partial) {
        return {
          answer: `${partial}\n\n(Interrupted before finishing — this is a partial answer; treat it as uncertain.)`,
          references: [],
          searched: [],
          confidence: PARTIAL_ANSWER_CONFIDENCE,
          timedOut: true,
        };
      }
      return {
        answer: "",
        references: [],
        searched: [],
        confidence: 0,
        timedOut: true,
      };
    }
    // Re-throw for the executor's triage: transient failures get the step's
    // auto-retry; deterministic ones degrade there.
    throw new Error(res.error ?? "Recall failed");
  }

  const report = res.report;
  if (!report) {
    // recallReport not called (or failed validation) — the model may have
    // written its answer as plain text instead; return it at low confidence.
    console.warn(
      "[Recall] recallReport not called. Final text:",
      res.text?.slice(0, 200) ?? "(no text)",
    );
    const text = res.text?.trim() ?? "";
    return {
      answer: text,
      references: [],
      searched: [],
      confidence: text ? PARTIAL_ANSWER_CONFIDENCE : 0,
    };
  }

  // Post-processing: drop references pointing at the ongoing conversation,
  // then drop hallucinated slice ids. NOTE: unlike the old pointer engine we
  // do NOT zero the confidence when every reference drops — an empty
  // references array is now the NORMAL state of an honest "no such memory"
  // answer, not evidence of a failed search.
  const rawRefs = report.references ?? [];
  const references = filterKnownSliceIds(
    excludeCurrentSlice(rawRefs, currentSliceId),
    validSliceIds,
  );
  const dropped = rawRefs.length - references.length;
  if (dropped > 0) {
    console.log(
      `[Recall] Excluded ${dropped} reference(s) (current slice or unknown id)`,
    );
  }

  console.log(
    `[Recall] Answered with ${references.length} reference(s), confidence=${(report.confidence ?? 0.5).toFixed(2)}, ${sliceQuota.used} full read(s)`,
  );
  return {
    answer: report.answer ?? "",
    references,
    searched: report.searched ?? [],
    confidence: report.confidence ?? 0.5,
  };
}
